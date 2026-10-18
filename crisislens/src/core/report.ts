// 报告生成：基于 InvestigationState + Claims + Evidence + Conflicts，
// 而不是从完整聊天历史里总结。证据不足必须产出明确的有限结果。
import type { Evidence, InvestigationState } from './types.ts';
import type { ClaimView } from './ports.ts';
import type { StopReason } from './stop.ts';

export interface ReportInput {
  state: InvestigationState;
  claims: ClaimView[];
  evidence: Evidence[];
  conflicts: { conflictId: string; claimId: string; supportingEvidenceIds: string[]; contradictingEvidenceIds: string[] }[];
  stopReason: StopReason | null;
  stopDetails: string[];
}

export interface Report {
  status: 'complete' | 'partial';
  stopReason: StopReason | null;
  /** 缺失或未取得的材料／结论。partial 时必须非空。 */
  missingMaterial: string[];
  sections: { title: string; body: string }[];
  markdown: string;
}

function sourceOf(evidence: Evidence[], evidenceId: string): string {
  return evidence.find((e) => e.evidenceId === evidenceId)?.sourceId ?? 'unknown';
}

export function generateReport(input: ReportInput): Report {
  const { state, claims, evidence, conflicts, stopReason, stopDetails } = input;

  const confirmed = claims.filter((c) => c.status === 'confirmed');
  const contested = claims.filter((c) => c.status === 'contested');
  const inconclusive = claims.filter((c) => c.status === 'inconclusive' || c.status === 'unsupported');
  const openQuestions = state.questions.filter((q) => q.status === 'open');
  const inconclusiveQuestions = state.questions.filter((q) => q.status === 'inconclusive');

  const missingMaterial: string[] = [];
  // 带上问题 id，保证报告里的每一条限制都能回溯到具体的调查问题。
  for (const q of openQuestions) missingMaterial.push(`未解决的问题：[${q.id}] ${q.text}`);
  for (const q of inconclusiveQuestions) missingMaterial.push(`无法裁定的问题：[${q.id}] ${q.text}`);
  for (const f of state.failedSources) {
    missingMaterial.push(`来源不可用 [${f.code}]：${f.tool} ${f.resourceId}（尝试 ${f.attempts} 次）`);
  }

  const status: Report['status'] =
    missingMaterial.length === 0 && stopReason === 'goal_complete' ? 'complete' : 'partial';

  const facts = confirmed.length
    ? confirmed
        .map((c) => {
          const cites = c.links
            .filter((l) => l.relation === 'supports')
            .map((l) => `[${sourceOf(evidence, l.evidenceId)}]`)
            .join('');
          return `- ${c.statement} ${cites}`;
        })
        .join('\n')
    : '- 本次调查未取得足以支持任何确定性结论的证据。';

  const evidenceLines = evidence.length
    ? evidence
        .map((e) => `- ${e.evidenceId} 来自 [${e.sourceId}]（${e.channel}）：${e.excerpt}`)
        .join('\n')
    : '- 未取得任何原文证据。';

  const conflictLines = [
    ...conflicts.map((c) => {
      const claim = claims.find((x) => x.claimId === c.claimId);
      const sup = c.supportingEvidenceIds.map((id) => sourceOf(evidence, id)).join('、');
      const con = c.contradictingEvidenceIds.map((id) => sourceOf(evidence, id)).join('、');
      return `- ${c.conflictId}：关于“${claim?.statement ?? c.claimId}”，支持来源 ${sup} 与反对来源 ${con} 并存，状态 unresolved。`;
    }),
    ...contested.map((c) => `- Claim ${c.claimId} 处于 contested，未作裁定。`),
    ...inconclusive.map((c) => `- Claim ${c.claimId}（${c.statement}）证据不足，保持 inconclusive。`),
  ].join('\n') || '- 未检测到来源冲突。';

  const conclusionLines: string[] = [];
  if (confirmed.length > 0) {
    conclusionLines.push(`已取得证据支持的结论 ${confirmed.length} 条，均带来源引用。`);
  } else {
    conclusionLines.push('没有足够证据支持任何确定性结论。');
  }
  if (contested.length > 0) {
    conclusionLines.push(`存在 ${contested.length} 条来源互相冲突的主张，未作裁定，保留来源归属。`);
  }
  if (status === 'partial') {
    conclusionLines.push('本次交付为有限结果：下列事项尚未取得证据，不应推断为已确认或已排除。');
  }
  conclusionLines.push(`停止原因：${stopReason ?? '未记录'}${stopDetails.length ? `（${stopDetails.join('；')}）` : ''}。`);

  const limitationLines = [
    ...(missingMaterial.length ? missingMaterial.map((m) => `- ${m}`) : ['- 无。']),
    `- 工具调用 ${state.toolCallsUsed}/${state.budget.maxToolCalls}，迭代 ${state.iterations}/${state.budget.maxIterations}。`,
  ].join('\n');

  const sections = [
    { title: '事实摘要', body: facts },
    { title: '证据与引用', body: evidenceLines },
    { title: '冲突与不确定性', body: conflictLines },
    { title: '结论', body: conclusionLines.map((l) => `- ${l}`).join('\n') },
    { title: '限制与后续核查', body: limitationLines },
  ];

  const markdown = [
    `# 舆情调查报告（${status === 'complete' ? '完整交付' : '有限结果'}）`,
    '',
    `调查目标：${state.objective}`,
    '',
    ...sections.flatMap((s) => [`## ${s.title}`, '', s.body, '']),
  ].join('\n');

  return { status, stopReason, missingMaterial, sections, markdown };
}
