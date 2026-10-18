// Core 语义测试：不依赖进程、网络、数据库、UI，只用假数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceStore, quoteIsVerifiable, firstSentenceContaining } from '../src/core/evidence.ts';
import { buildModelContext } from '../src/core/context.ts';
import { createInitialState, syncQuestionsFromClaims } from '../src/core/state.ts';
import { DEFAULT_BUDGET } from '../src/core/state.ts';
import { evaluateStop } from '../src/core/stop.ts';
import { generateReport } from '../src/core/report.ts';
import type { InvestigationTask } from '../src/core/types.ts';

const task: InvestigationTask = {
  taskId: 't1',
  caseId: 'c1',
  userTask: '调查某事件',
  entities: ['E'],
  questions: [
    { id: 'Q1', text: '是否存在反馈？', status: 'open', positiveTerms: ['反馈'], negativeTerms: [] },
    { id: 'Q2', text: '是否涉及批次 B？', status: 'open', positiveTerms: ['批次 B'], negativeTerms: ['没有批次 B'] },
  ],
  budget: { ...DEFAULT_BUDGET },
};

test('Claim 无证据时为 unsupported，有支持证据后转 confirmed', () => {
  const store = createEvidenceStore();
  store.registerClaim({
    claimId: 'Q1',
    statement: '是否存在反馈？',
    links: [],
    status: 'unsupported',
    positiveTerms: ['反馈'],
    negativeTerms: [],
  });
  assert.equal(store.getClaim('Q1')?.status, 'unsupported');

  const e = store.addEvidence({ sourceId: 'S1', channel: 'public', excerpt: 'x', quote: '反馈' });
  store.linkEvidenceToClaim('Q1', e.evidenceId, 'supports');
  assert.equal(store.getClaim('Q1')?.status, 'confirmed');
});

test('同一 Claim 上支持与反对并存时产生 Conflict', () => {
  const store = createEvidenceStore();
  store.registerClaim({
    claimId: 'Q2',
    statement: '是否涉及批次 B？',
    links: [],
    status: 'unsupported',
    positiveTerms: ['批次 B'],
    negativeTerms: ['没有批次 B'],
  });
  const support = store.addEvidence({ sourceId: 'S1', channel: 'public', excerpt: 'a', quote: '批次 B' });
  const contradict = store.addEvidence({ sourceId: 'S2', channel: 'public', excerpt: 'b', quote: '没有批次 B' });
  store.linkEvidenceToClaim('Q2', support.evidenceId, 'supports');
  store.linkEvidenceToClaim('Q2', contradict.evidenceId, 'contradicts');

  assert.equal(store.getClaim('Q2')?.status, 'contested');
  const conflicts = store.detectConflicts();
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]?.supportingEvidenceIds, [support.evidenceId]);
  // 重复检测不得产生第二个冲突
  assert.equal(store.detectConflicts().length, 0);
});

test('引文必须是原文子串，伪造引文被拒绝', () => {
  const content = '报告日期：2024-03-04。该报告不覆盖批次 B。';
  assert.equal(quoteIsVerifiable('不覆盖批次 B', content), true);
  assert.equal(quoteIsVerifiable('批次 B 已合格', content), false);
  assert.equal(quoteIsVerifiable('', content), false);
});

test('引文抽取优先命中关键措辞所在的句子', () => {
  const content = '第一条句子。该报告不覆盖批次 B。第三条。';
  const quote = firstSentenceContaining(content, ['批次 B']);
  assert.equal(quote, '该报告不覆盖批次 B。');
  assert.equal(content.includes(quote), true);
});

test('问题被标为 resolved 后出现冲突，会回退为 inconclusive 并派生核验步骤', () => {
  const state = createInitialState(task);
  state.questions[1]!.status = 'resolved';
  const result = syncQuestionsFromClaims(state, [{ claimId: 'Q2', status: 'contested' }]);
  assert.equal(state.questions.find((q) => q.id === 'Q2')?.status, 'inconclusive');
  assert.equal(result.derived.length, 1);
  assert.ok(state.questions.some((q) => q.id === 'Q2-verify'));
  assert.ok(state.planSteps.some((s) => s.triggeredBy === 'conflict:Q2'));
  // 幂等：再次同步不得重复派生
  const again = syncQuestionsFromClaims(state, [{ claimId: 'Q2', status: 'contested' }]);
  assert.equal(again.derived.length, 0);
});

test('停止条件：预算耗尽优先于其它原因', () => {
  const state = createInitialState(task);
  state.toolCallsUsed = state.budget.maxToolCalls;
  const d = evaluateStop({ state, claimStatuses: [], unreadCandidateCount: 3 });
  assert.equal(d.reason, 'budget_exhausted');
});

test('停止条件：无未解决问题且有已确认主张时为 goal_complete', () => {
  const state = createInitialState(task);
  for (const q of state.questions) q.status = 'resolved';
  const d = evaluateStop({
    state,
    claimStatuses: [
      { claimId: 'Q1', status: 'confirmed' },
      { claimId: 'Q2', status: 'confirmed' },
    ],
    unreadCandidateCount: 0,
  });
  assert.equal(d.shouldStop, true);
  assert.equal(d.reason, 'goal_complete');
});

test('停止条件：连续无进展达到阈值时为 information_saturated', () => {
  const state = createInitialState(task);
  state.noProgressCount = 3;
  const d = evaluateStop({ state, claimStatuses: [], unreadCandidateCount: 2 });
  assert.equal(d.reason, 'information_saturated');
});

test('停止条件：无未读候选且存在失败来源时为 blocked 且需要人工', () => {
  const state = createInitialState(task);
  state.failedSources.push({ tool: 'read_internal_doc', resourceId: 'D1', code: 'permission_denied', attempts: 1 });
  const d = evaluateStop({ state, claimStatuses: [], unreadCandidateCount: 0 });
  assert.equal(d.reason, 'blocked');
  assert.equal(d.requiresHuman, true);
});

test('上下文预算会裁剪候选与引文，但至少保留一条证据', () => {
  const state = createInitialState(task);
  const ctx = buildModelContext({
    state,
    evidence: Array.from({ length: 20 }, (_, i) => ({
      evidenceId: `E${i}`,
      sourceId: `S${i}`,
      quote: '很长的引文'.repeat(20),
    })),
    candidates: Array.from({ length: 10 }, (_, i) => ({
      sourceId: `S${i}`,
      title: `标题${i}`,
      channel: 'public' as const,
      snippet: `摘要${i}`,
    })),
    contextBudgetChars: 1200,
  });
  const chars = Array.from(JSON.stringify(ctx)).length;
  assert.ok(chars <= 1400, `上下文应被裁剪，实际 ${chars}`);
  assert.ok(ctx.relevantEvidence.length >= 1, '不得把所有证据裁光');
});

test('证据不足时报告为 partial 且列出缺失事项', () => {
  const state = createInitialState(task);
  state.failedSources.push({ tool: 'fetch_source', resourceId: 'S9', code: 'timeout', attempts: 2 });
  const report = generateReport({
    state,
    claims: [{ claimId: 'Q1', statement: '是否存在反馈？', status: 'inconclusive', links: [] }],
    evidence: [],
    conflicts: [],
    stopReason: 'partial_delivery',
    stopDetails: [],
  });
  assert.equal(report.status, 'partial');
  assert.ok(report.missingMaterial.some((m) => m.includes('S9')));
  assert.ok(report.markdown.includes('有限结果'));
  assert.ok(report.markdown.includes('没有足够证据支持任何确定性结论'));
});

test('报告中的每条结论都带来源引用', () => {
  const state = createInitialState(task);
  const store = createEvidenceStore();
  const e = store.addEvidence({ sourceId: 'S1', channel: 'public', excerpt: 'x', quote: '反馈' });
  store.registerClaim({
    claimId: 'Q1',
    statement: '是否存在反馈？',
    links: [],
    status: 'unsupported',
    positiveTerms: ['反馈'],
    negativeTerms: [],
  });
  store.linkEvidenceToClaim('Q1', e.evidenceId, 'supports');
  for (const q of state.questions) q.status = 'resolved';
  const report = generateReport({
    state,
    claims: store.listClaims(),
    evidence: store.list(),
    conflicts: [],
    stopReason: 'goal_complete',
    stopDetails: [],
  });
  assert.equal(report.status, 'complete');
  assert.ok(report.sections.find((s) => s.title === '事实摘要')?.body.includes('[S1]'));
});
