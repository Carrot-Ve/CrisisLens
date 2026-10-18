// StopEvaluator：停止由系统规则决定，不靠模型“感觉差不多了”。
// 停止判断放在最新 Evidence 与 State 更新之后。
import type { InvestigationState } from './types.ts';

export type StopReason =
  | 'goal_complete'
  | 'information_saturated'
  | 'budget_exhausted'
  | 'iteration_limit'
  | 'blocked'
  | 'human_escalation'
  | 'cancelled'
  /** 调查结束但存在未取得证据的事项，交付有限结果。 */
  | 'partial_delivery';

export interface StopDecision {
  shouldStop: boolean;
  reason: StopReason | null;
  details: string[];
  requiresHuman: boolean;
}

export interface StopInput {
  state: InvestigationState;
  claimStatuses: { claimId: string; status: string }[];
  /** 仍有候选来源尚未读取。用于区分 blocked 与可以继续换来源。 */
  unreadCandidateCount: number;
}

const NO_PROGRESS_LIMIT = 3;

export function evaluateStop(input: StopInput): StopDecision {
  const { state, claimStatuses, unreadCandidateCount } = input;
  const details: string[] = [];

  if (state.toolCallsUsed >= state.budget.maxToolCalls) {
    details.push(`工具调用已用尽：${state.toolCallsUsed}/${state.budget.maxToolCalls}`);
    return { shouldStop: true, reason: 'budget_exhausted', details, requiresHuman: false };
  }
  if (state.iterations >= state.budget.maxIterations) {
    details.push(`迭代次数达到上限：${state.iterations}/${state.budget.maxIterations}`);
    return { shouldStop: true, reason: 'iteration_limit', details, requiresHuman: false };
  }

  const open = state.questions.filter((q) => q.status === 'open');
  const terminal = state.questions.filter((q) => q.status !== 'open');
  const confirmed = claimStatuses.filter((c) => c.status === 'confirmed');

  if (open.length === 0 && terminal.length > 0 && confirmed.length > 0) {
    details.push(`全部 ${terminal.length} 个调查问题进入终态，其中 ${confirmed.length} 个有支持证据`);
    return { shouldStop: true, reason: 'goal_complete', details, requiresHuman: false };
  }

  if (state.noProgressCount >= NO_PROGRESS_LIMIT) {
    details.push(`连续 ${state.noProgressCount} 轮没有产生新的有效证据或来源`);
    return { shouldStop: true, reason: 'information_saturated', details, requiresHuman: false };
  }

  if (open.length > 0 && unreadCandidateCount === 0 && state.failedSources.length > 0) {
    details.push(
      `仍有 ${open.length} 个未解决问题，但已无未读候选来源，且存在 ${state.failedSources.length} 个失败来源`,
    );
    return { shouldStop: true, reason: 'blocked', details, requiresHuman: true };
  }

  return { shouldStop: false, reason: null, details, requiresHuman: false };
}
