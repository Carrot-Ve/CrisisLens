// Agent Core 领域类型。纯 TypeScript：不允许 import 任何 SDK、适配器或 I/O 模块。
// 第一性原理问题：这些类型分别保护哪个领域区分？
//   Task        —— 用户到底要调查什么
//   Source      —— 信息来自哪里（候选／已读）
//   Evidence    —— 这份材料里哪一段能用于事实判断
//   Claim       —— 我们现在在判断什么
//   Conflict    —— 同一 Claim 上 supports 与 contradicts 并存
//   State       —— 调查进行到哪里

/** 工具名。首批四个工具，严格区分“发现候选”与“读取原文”。 */
export type ToolName =
  | 'search_sources'
  | 'fetch_source'
  | 'search_internal_docs'
  | 'read_internal_doc';

/**
 * 工具结果状态。必须可区分：
 *   ok                 —— 成功（可能为空结果）
 *   empty              —— 成功但零命中，是一种有效观察，不是失败
 *   not_found          —— 资源不存在
 *   permission_denied  —— 无权限，不重试
 *   timeout            —— 超时，可有限重试
 *   rate_limited       —— 限流，backoff 后重试
 *   source_unavailable —— 资源不可用（如已删除）
 *   invalid_argument   —— 参数不合法，需改参数而非原样重试
 *   wrong_tool         —— 用错工具通道（如用 fetch_source 读内部文档）
 *   retry_exhausted    —— 重试次数用尽，仍未成功
 *   budget_exhausted   —— 夹具整体调用预算用尽
 */
export type ToolErrorCode =
  | 'ok'
  | 'empty'
  | 'not_found'
  | 'permission_denied'
  | 'timeout'
  | 'rate_limited'
  | 'source_unavailable'
  | 'invalid_argument'
  | 'wrong_tool'
  | 'retry_exhausted'
  | 'budget_exhausted';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** 该错误是否值得重试。由错误分类决定，而不是统一 retry。 */
  retryable: boolean;
}

/** 搜索命中的候选来源元数据。摘要不是证据。 */
export interface SourceCandidate {
  sourceId: string;
  title: string;
  channel: 'public' | 'internal';
  snippet: string;
}

export interface SourceContent {
  sourceId: string;
  title: string;
  channel: 'public' | 'internal';
  content: string;
}

/** 一条工具结果。永远带 status，调用方不需要 try/catch 判空。 */
export type ToolResult =
  | { status: 'ok'; tool: ToolName; candidates: SourceCandidate[] }
  | { status: 'ok'; tool: ToolName; source: SourceContent }
  | { status: Extract<ToolErrorCode, 'empty'>; tool: ToolName; candidates: SourceCandidate[] }
  | { status: Exclude<ToolErrorCode, 'ok' | 'empty'>; tool: ToolName; error: ToolError };

/** 失败类工具状态码。适配器用它保证不会把 ok 当成错误上报。 */
export type ToolFailureCode = Exclude<ToolErrorCode, 'ok' | 'empty'>;

export interface ToolIntent {
  tool: ToolName;
  args: Record<string, unknown>;
}

export type EvidenceRelation = 'supports' | 'contradicts' | 'inconclusive';

export interface Evidence {
  evidenceId: string;
  sourceId: string;
  channel: 'public' | 'internal';
  /** 原文片段，尽量贴近原始材料，而不是模型总结。 */
  excerpt: string;
  /** 用于支撑判断的引文，必须是原文子串。 */
  quote: string;
  contentHash: string;
  retrievedAt: number;
}

export type ClaimStatus =
  | 'open'
  | 'confirmed'
  | 'contested'
  | 'inconclusive'
  | 'unsupported';

export interface ClaimLink {
  evidenceId: string;
  relation: EvidenceRelation;
}

export interface Claim {
  claimId: string;
  statement: string;
  links: ClaimLink[];
  status: ClaimStatus;
  /** 判定该 Claim 时需要出现的正向措辞。来自任务澄清，不是 Gold。 */
  positiveTerms: string[];
  /** 出现视为反对该 Claim 的措辞。 */
  negativeTerms: string[];
}

export interface Conflict {
  conflictId: string;
  claimId: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  status: 'unresolved';
}

export interface ToolFailure {
  tool: ToolName;
  resourceId: string;
  code: ToolErrorCode;
  attempts: number;
}

export type QuestionStatus = 'open' | 'resolved' | 'inconclusive';

export interface Question {
  id: string;
  text: string;
  status: QuestionStatus;
  /**
   * 澄清调查范围时记录的判据措辞：出现正向措辞视为支持该问题对应的主张。
   * 来自任务澄清，不是评测 Gold；被测 Agent 只能拿到这些措辞，拿不到预期结论。
   */
  positiveTerms?: string[];
  /** 出现反对措辞视为反对该主张。 */
  negativeTerms?: string[];
}

export type PlanStepStatus = 'pending' | 'done' | 'dropped';

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
  /** 为什么产生这一步：initial 或由某条 evidence/conflict 触发。 */
  triggeredBy: 'initial' | string;
}

export interface RunBudget {
  maxToolCalls: number;
  maxIterations: number;
  maxRetriesPerResource: number;
  timeoutMs: number;
  maxTokens: number;
}

export type InvestigationStatus =
  | 'investigating'
  | 'ready_to_report'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface InvestigationState {
  objective: string;
  entities: string[];
  questions: Question[];
  planSteps: PlanStep[];
  evidenceRefs: string[];
  claimRefs: string[];
  conflicts: Conflict[];
  failedSources: ToolFailure[];
  readSourceIds: string[];
  triedQueries: string[];
  nextActions: string[];
  toolCallsUsed: number;
  iterations: number;
  budget: RunBudget;
  /** 连续多少轮没有产生新的有效证据／来源。用于 information_saturated。 */
  noProgressCount: number;
  status: InvestigationStatus;
}

/** 用户输入后的调查任务。questions 来自“澄清调查范围”这一步。 */
export interface InvestigationTask {
  taskId: string;
  caseId: string;
  userTask: string;
  entities: string[];
  questions: Question[];
  budget: RunBudget;
}
