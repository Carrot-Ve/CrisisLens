// 工具夹具语义 + Runtime 可靠性测试。
// 重点：成功空结果 / 超时 / 权限拒绝 / 资源不存在必须可区分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRunner, toToolPort } from '../src/adapters/tools/deterministic-tools.ts';
import { createFakeModel } from '../src/adapters/model/fake-model.ts';
import { runInvestigation } from '../src/runtime/runtime.ts';
import { replay } from '../src/runtime/event-log.ts';
import { DEFAULT_BUDGET } from '../src/core/state.ts';
import type { InvestigationTask } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const datasetRoot = resolve(here, '..', '..', 'crisislens_dataset');

test('成功空结果与真正的失败可区分', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  assert.deepEqual(runner.call('search_sources', { query: '不存在的来源' }), { status: 'ok', items: [] });
  assert.equal(runner.call('fetch_source', { id: 'no_such_source' }).status, 'not_found');
});

test('通道用错：内部材料不能用 fetch_source 读取', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  assert.equal(runner.call('fetch_source', { id: 'qc_report_001' }).status, 'wrong_tool');
  assert.equal(runner.call('read_internal_doc', { id: 'complaint_001' }).status, 'wrong_tool');
});

test('无权限材料返回 permission_denied，且不泄露正文', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  const denied = runner.call('read_internal_doc', { id: 'supplier_contract_001' });
  assert.equal(denied.status, 'permission_denied');
  assert.ok(!JSON.stringify(runner.trace).includes('CANARY_CONTRACT'));
  assert.ok(!JSON.stringify(denied).includes('CANARY_CONTRACT'));
});

test('路径穿越被拒绝为 not_found', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  assert.equal(runner.call('fetch_source', { id: '../../schemas/gold.schema.json' }).status, 'not_found');
});

test('持续超时：重试一次后仍失败，最终 retry_exhausted', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001_timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'retry_exhausted');
});

test('瞬时超时：一次重试后成功', () => {
  const runner = createFixtureRunner(datasetRoot, 'process_permission_recovery_001');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'ok');
});

test('整体调用预算耗尽后拒绝新的调用', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  for (let i = 0; i < runner.manifest.budget.max_tool_calls; i++) {
    runner.call('search_sources', { query: '青禾酥饼' });
  }
  assert.equal(runner.call('fetch_source', { id: 'complaint_001' }).status, 'budget_exhausted');
});

test('交给 Agent 的输入投影不含 Gold 与内部路径', () => {
  const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
  const text = JSON.stringify(runner.input);
  for (const forbidden of ['gold_ref', 'expected_conclusion', 'necessary_evidence', 'content_ref', 'CANARY_CONTRACT']) {
    assert.ok(!text.includes(forbidden), `输入投影不得包含 ${forbidden}`);
  }
});

function task(caseId: string): InvestigationTask {
  return {
    taskId: `t_${caseId}`,
    caseId,
    userTask: '调查青禾酥饼异物反馈事件',
    entities: ['青禾酥饼'],
    questions: [
      { id: 'Q1', text: '是否存在消费者异物反馈记录？', status: 'open', positiveTerms: ['发现疑似', '异物反馈记录'], negativeTerms: [] },
      { id: 'Q2', text: '反馈记录是否涉及批次 B？', status: 'open', positiveTerms: ['批次 B'], negativeTerms: ['没有批次 B 反馈'] },
      { id: 'Q4', text: '是否存在覆盖批次 B 的质检结论？', status: 'open', positiveTerms: ['覆盖批次 B'], negativeTerms: ['不覆盖批次 B'] },
    ],
    budget: { ...DEFAULT_BUDGET },
  };
}

function deps(caseId: string) {
  const runner = createFixtureRunner(datasetRoot, caseId);
  return { runner, model: createFakeModel(), tools: toToolPort(runner) };
}

test('基线运行：产出证据、带引用的报告，且不产生虚假冲突', async () => {
  const d = deps('food_foreign_object_001');
  const outcome = await runInvestigation(task('food_foreign_object_001'), d, { runId: 'r_base' });
  const conflicts = outcome.events.filter((e) => e.type === 'conflict_detected');
  assert.equal(conflicts.length, 0);
  assert.ok(outcome.events.some((e) => e.type === 'evidence_created'));
  assert.ok(outcome.report.markdown.includes('[complaint_003]'));
  assert.ok(outcome.events.some((e) => e.type === 'run_completed'));
  assert.ok(outcome.report.missingMaterial.length > 0, '证据不足的事项必须写明');
});

test('冲突变体：冲突被检测到，并驱动新的调查动作', async () => {
  const base = await runInvestigation(task('food_foreign_object_001_conflict'), deps('food_foreign_object_001_conflict'), { runId: 'r_conf' });
  const conflictEvents = base.events.filter((e) => e.type === 'conflict_detected');
  assert.equal(conflictEvents.length, 1);
  const conflictSeq = conflictEvents[0]!.sequence;
  const planAfter = base.events.filter((e) => e.type === 'plan_updated' && e.sequence > conflictSeq);
  assert.ok(planAfter.length >= 1, '冲突后必须产生计划更新');
  const toolAfter = base.events.filter((e) => e.type === 'tool_started' && e.sequence > conflictSeq);
  assert.ok(toolAfter.length >= 1, '冲突后必须产生新的工具调用');
  assert.ok(base.report.missingMaterial.some((m) => m.includes('Q2')), '冲突问题必须保留为不确定项');
});

test('超时变体：工具失败被记录为来源不可用，且不写成空结果', async () => {
  const outcome = await runInvestigation(task('food_foreign_object_001_timeout'), deps('food_foreign_object_001_timeout'), { runId: 'r_to' });
  const failures = outcome.events.filter((e) => e.type === 'tool_completed' && e.status === 'timeout');
  assert.ok(failures.length >= 1);
  assert.ok(outcome.report.missingMaterial.some((m) => m.includes('qc_report_001')));
  assert.ok(outcome.report.missingMaterial.some((m) => m.includes('timeout')));
});

test('取消：运行被中止后不再产生新的工具调用，并落 run_cancelled', async () => {
  const controller = new AbortController();
  const d = deps('food_foreign_object_001');
  const original = d.tools.execute.bind(d.tools);
  let calls = 0;
  const wrapped = {
    name: d.tools.name,
    async execute(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
      calls += 1;
      if (calls === 2) controller.abort();
      return original(tool, args, signal);
    },
  };
  const outcome = await runInvestigation(task('food_foreign_object_001'), { ...d, tools: wrapped }, {
    runId: 'r_cancel',
    signal: controller.signal,
  });
  assert.ok(outcome.events.some((e) => e.type === 'run_cancelled'));
  assert.equal(calls, 2, '取消后不得继续调用工具');
});

test('事件日志回放是幂等的', async () => {
  const outcome = await runInvestigation(task('food_foreign_object_001'), deps('food_foreign_object_001'), { runId: 'r_replay' });
  const first = replay(outcome.events);
  const second = replay(replay(outcome.events) ? outcome.events : outcome.events);
  assert.deepEqual(first.evidenceIds, second.evidenceIds);
  assert.deepEqual(first.toolCalls, second.toolCalls);
  assert.equal(new Set(first.evidenceIds).size, first.evidenceIds.length, '回放不得重复计入证据');
});

test('两次运行互不共享状态与证据', async () => {
  const a = await runInvestigation(task('food_foreign_object_001'), deps('food_foreign_object_001'), { runId: 'r_iso_a' });
  const b = await runInvestigation(task('food_foreign_object_001'), deps('food_foreign_object_001'), { runId: 'r_iso_b' });
  assert.equal(a.runId, 'r_iso_a');
  assert.equal(b.runId, 'r_iso_b');
  const evA = a.events.filter((e) => e.type === 'evidence_created').map((e) => (e as { evidenceId: string }).evidenceId);
  const evB = b.events.filter((e) => e.type === 'evidence_created').map((e) => (e as { evidenceId: string }).evidenceId);
  assert.deepEqual(evA, evB, '同一夹具两次运行的证据序列应一致');
  assert.equal(new Set(evA).size, evA.length);
});
