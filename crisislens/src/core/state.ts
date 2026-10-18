// InvestigationState：调查进行到哪里的显式工作台。
// 它不是 Conversation，不是 Evidence Store，也不是 Trace。
import type {
  InvestigationState,
  InvestigationTask,
  PlanStep,
  Question,
  QuestionStatus,
  RunBudget,
  ToolFailure,
} from './types.ts';

export const DEFAULT_BUDGET: RunBudget = {
  maxToolCalls: 14,
  maxIterations: 12,
  maxRetriesPerResource: 1,
  timeoutMs: 30_000,
  maxTokens: 30_000,
};

export function createInitialState(task: InvestigationTask): InvestigationState {
  const plan: PlanStep[] = [
    planStep('P1', '检索公开来源，发现候选材料', 'initial'),
    planStep('P2', '读取与调查问题直接相关的公开原文', 'initial'),
    planStep('P3', '检索已授权内部材料', 'initial'),
    planStep('P4', '读取与调查问题直接相关的内部原文', 'initial'),
    planStep('P5', '比对来源、识别冲突与缺口，产出带引用的报告', 'initial'),
  ];
  return {
    objective: task.userTask,
    entities: task.entities.slice(),
    questions: task.questions.map((q) => ({ id: q.id, text: q.text, status: 'open' })),
    planSteps: plan,
    evidenceRefs: [],
    claimRefs: task.questions.map((q) => q.id),
    conflicts: [],
    failedSources: [],
    readSourceIds: [],
    triedQueries: [],
    nextActions: ['检索公开来源'],
    toolCallsUsed: 0,
    iterations: 0,
    budget: { ...task.budget },
    noProgressCount: 0,
    status: 'investigating',
  };
}

function planStep(id: string, text: string, triggeredBy: string): PlanStep {
  return { id, text, status: 'pending', triggeredBy };
}

export function addPlanStep(
  state: InvestigationState,
  text: string,
  triggeredBy: string,
): PlanStep {
  const step = planStep(`P${state.planSteps.length + 1}`, text, triggeredBy);
  state.planSteps.push(step);
  return step;
}

export function markPlanStepDone(state: InvestigationState, id: string): void {
  const step = state.planSteps.find((s) => s.id === id);
  if (step) step.status = 'done';
}

export function recordFailure(
  state: InvestigationState,
  failure: ToolFailure,
): void {
  const existing = state.failedSources.find(
    (f) => f.tool === failure.tool && f.resourceId === failure.resourceId,
  );
  if (existing) {
    existing.code = failure.code;
    existing.attempts = failure.attempts;
    return;
  }
  state.failedSources.push(failure);
}

export function hasFailed(state: InvestigationState, tool: string, resourceId: string): boolean {
  return state.failedSources.some((f) => f.tool === tool && f.resourceId === resourceId);
}

export function resolveQuestion(state: InvestigationState, id: string): void {
  const q = state.questions.find((item) => item.id === id);
  if (q && q.status === 'open') q.status = 'resolved';
}

export function markQuestionInconclusive(state: InvestigationState, id: string): void {
  const q = state.questions.find((item) => item.id === id);
  if (q && q.status === 'open') q.status = 'inconclusive';
}

export function openQuestions(state: InvestigationState): Question[] {
  return state.questions.filter((q) => q.status === 'open');
}

export function pendingPlanSteps(state: InvestigationState): PlanStep[] {
  return state.planSteps.filter((s) => s.status === 'pending');
}

/**
 * 根据证据／冲突更新 Claim 与 Question 状态。
 * Claim 状态由 EvidenceStore 计算，这里只同步问题终态：
 * 有支持证据 → resolved；只有不确定关系 → 保持 open，直到轮次结束再转 inconclusive；
 * 被 contested → 明确 unresolved，并派生新的调查问题。
 */
export interface SyncResult {
  /** 由冲突派生的新调查动作文本。 */
  derived: string[];
  /** 本轮状态发生变化的 question。 */
  updatedQuestions: { id: string; status: QuestionStatus }[];
}

export function syncQuestionsFromClaims(
  state: InvestigationState,
  claims: { claimId: string; status: string }[],
): SyncResult {
  const derived: string[] = [];
  const updatedQuestions: { id: string; status: QuestionStatus }[] = [];
  for (const claim of claims) {
    const question = state.questions.find((q) => q.id === claim.claimId);
    if (!question) continue;
    if (claim.status === 'confirmed' && question.status === 'open') {
      question.status = 'resolved';
      updatedQuestions.push({ id: question.id, status: question.status });
      continue;
    }
    // 冲突可能在问题已被标为 resolved 之后才出现（先读到支持证据，后读到反对证据）。
    // 这种情况必须回退为 inconclusive 并派生核验动作，否则冲突会被静默吞掉。
    if (claim.status === 'contested' && question.status !== 'inconclusive') {
      question.status = 'inconclusive';
      updatedQuestions.push({ id: question.id, status: question.status });
      const verifyId = `${claim.claimId}-verify`;
      if (!state.questions.some((q) => q.id === verifyId)) {
        const text = `核验冲突来源的口径与时间范围：${question.text}`;
        state.questions.push({
          id: verifyId,
          text,
          status: 'open',
          ...(question.positiveTerms ? { positiveTerms: question.positiveTerms.slice() } : {}),
          ...(question.negativeTerms ? { negativeTerms: question.negativeTerms.slice() } : {}),
        });
        addPlanStep(state, text, `conflict:${claim.claimId}`);
        derived.push(text);
      }
    }
  }
  return { derived, updatedQuestions };
}
