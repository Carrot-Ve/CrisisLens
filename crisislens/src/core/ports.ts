// Core 对外只依赖端口。SDK／HTTP／文件系统全部挡在端口之后。
import type {
  Evidence,
  EvidenceRelation,
  InvestigationState,
  SourceContent,
  ToolResult,
} from './types.ts';

/**
 * 模型端口。Core 只描述“要什么”，不描述“怎么调”。
 * decide  —— 基于当前工作集决定下一步
 * interpret —— 把一次成功的原文读取解释为证据与关系判断
 */
export interface ModelPort {
  readonly name: string;
  decide(input: ModelInput, signal: AbortSignal): Promise<Decision>;
  interpret(input: InterpretInput, signal: AbortSignal): Promise<Interpretation>;
}

export interface ModelInput {
  objective: string;
  entities: string[];
  openQuestions: { id: string; text: string; positiveTerms: string[]; negativeTerms: string[] }[];
  pendingPlanSteps: { id: string; text: string; triggeredBy: string }[];
  readSourceIds: string[];
  triedQueries: string[];
  failedSources: { tool: string; resourceId: string; code: string }[];
  knownCandidates: { sourceId: string; title: string; channel: string; snippet: string }[];
  toolCallsUsed: number;
  budget: { maxToolCalls: number };
}

export interface InterpretInput {
  source: { sourceId: string; title: string; channel: 'public' | 'internal'; content: string };
  claims: { claimId: string; statement: string; positiveTerms: string[]; negativeTerms: string[] }[];
}

/** 结构化证据抽取结果。引文必须是原文子串，不允许凭空生成。 */
export interface ExtractedEvidence {
  sourceId: string;
  channel: 'public' | 'internal';
  excerpt: string;
  quote: string;
}

export interface ClaimJudgement {
  claimId: string;
  relation: EvidenceRelation;
  /** 该判断依据的原文片段。 */
  basis: string;
}

export interface Interpretation {
  evidence: ExtractedEvidence[];
  /** 针对已有 Claim 的关系判断。空数组表示本轮没有可判断的关系。 */
  judgements: ClaimJudgement[];
}

export type Decision =
  /** 调用一个工具 */
  | { kind: 'call_tool'; tool: string; args: Record<string, unknown>; rationale: string }
  /** 模型认为可以交付报告；是否真的停由 Runtime 的 StopEvaluator 决定 */
  | { kind: 'report'; rationale: string }
  /** 需要人工介入，例如关键材料需要授权 */
  | { kind: 'escalate'; question: string; rationale: string };

/** 工具端口。权限与错误分类由适配器负责，Core 只消费结构化 ToolResult。 */
export interface ToolPort {
  readonly name: string;
  execute(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

/** 证据／Claim 存储。Core 只通过它读写，不关心落盘方式。 */
export interface EvidenceStore {
  addEvidence(input: {
    sourceId: string;
    channel: 'public' | 'internal';
    excerpt: string;
    quote: string;
  }): Evidence;
  list(): Evidence[];
  findBySource(sourceId: string): Evidence[];
  linkEvidenceToClaim(claimId: string, evidenceId: string, relation: EvidenceRelation): void;
  getClaim(claimId: string): ClaimView | undefined;
  listClaims(): ClaimView[];
  claimsFor(state: InvestigationState): ClaimView[];
}

export interface ClaimView {
  claimId: string;
  statement: string;
  status: string;
  links: { evidenceId: string; relation: EvidenceRelation }[];
}

export function isSuccess(result: ToolResult): boolean {
  return result.status === 'ok' || result.status === 'empty';
}

export function asSourceContent(result: ToolResult): SourceContent | undefined {
  return result.status === 'ok' && 'source' in result ? result.source : undefined;
}

export function asCandidates(result: ToolResult): { sourceId: string; title: string; channel: 'public' | 'internal'; snippet: string }[] {
  if (result.status === 'ok' && 'candidates' in result) return result.candidates;
  if (result.status === 'empty') return [];
  return [];
}
