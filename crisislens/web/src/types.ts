// 与后端 /api 响应契约一致的类型。前端不重新推导领域语义，只描述传输结构。
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ReportStatus = 'complete' | 'partial';

export interface TaskSummary {
  taskId: string;
  caseId: string;
  userTask: string;
  createdAt: number;
  latestRunId: string | null;
  latestStatus: RunStatus | null;
  latestStopReason: string | null;
  evidenceCount: number;
  conflictCount: number;
}

export interface Question {
  id: string;
  text: string;
  status: 'open' | 'resolved' | 'inconclusive';
  positiveTerms?: string[];
  negativeTerms?: string[];
}

export interface TaskDetail {
  taskId: string;
  caseId: string;
  userTask: string;
  entities: string[];
  questions: Question[];
  budget: {
    maxToolCalls: number;
    maxIterations: number;
    maxRetriesPerResource: number;
    timeoutMs: number;
    maxTokens: number;
  };
  createdAt: number;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  status: RunStatus;
  stopReason: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  toolCalls: number;
  evidenceCount: number;
  conflictCount: number;
}

export interface EvidenceItem {
  evidenceId: string;
  sourceId: string;
  channel: 'public' | 'internal';
  excerpt: string;
  quote: string;
  contentHash: string;
  retrievedAt: number;
}

export interface ClaimItem {
  claimId: string;
  statement: string;
  status: 'open' | 'confirmed' | 'contested' | 'inconclusive' | 'unsupported';
  links: { evidenceId: string; relation: string }[];
}

export interface ConflictItem {
  conflictId: string;
  claimId: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  status: string;
}

export interface ReportItem {
  runId: string;
  status: ReportStatus;
  stopReason: string | null;
  markdown: string;
  missingMaterial: string[];
  sections: { title: string; body: string }[];
  createdAt: number;
}

export interface EventItem {
  sequence: number;
  type: string;
  timestamp: number;
  payload: string;
}

export interface RunDetail {
  run: RunSummary;
  task: TaskDetail | null;
  events: EventItem[];
  evidence: EvidenceItem[];
  claims: ClaimItem[];
  conflicts: ConflictItem[];
  report: ReportItem | null;
}
