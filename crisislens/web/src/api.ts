// API 客户端。统一处理非 2xx：把后端的 { error } 原样抛出，前端不猜测原因。
import type {
  EvidenceItem,
  ClaimItem,
  ConflictItem,
  RunDetail,
  RunSummary,
  TaskDetail,
  TaskSummary,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });
  const text = await res.text();
  const body: unknown = text.length > 0 ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `请求失败（${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export interface CaseSpec {
  caseId: string;
  userTask: string;
  entities: string[];
  questions: { id: string; text: string; positiveTerms?: string[]; negativeTerms?: string[] }[];
  /** baseline = 基础事件族；challenge = 人为构造的压力变体。 */
  kind: 'baseline' | 'challenge';
  label: string;
  challengeType?: string;
}

export function listCases(): Promise<{ cases: CaseSpec[] }> {
  return request('/cases');
}

export interface CreateTaskInput {
  caseId: string;
  userTask: string;
  entities: string[];
  questions: { id: string; text: string; positiveTerms?: string[]; negativeTerms?: string[] }[];
}

export function listTasks(): Promise<{ tasks: TaskSummary[] }> {
  return request('/tasks');
}

export function createTask(input: CreateTaskInput): Promise<{ task: TaskSummary }> {
  return request('/tasks', { method: 'POST', body: JSON.stringify(input) });
}

export function getTask(taskId: string): Promise<{ task: TaskDetail; runs: RunSummary[] }> {
  return request(`/tasks/${encodeURIComponent(taskId)}`);
}

export function startRun(taskId: string): Promise<{ runId: string }> {
  return request(`/tasks/${encodeURIComponent(taskId)}/runs`, { method: 'POST' });
}

export function getRun(runId: string): Promise<{ run: RunSummary }> {
  return request(`/runs/${encodeURIComponent(runId)}`);
}

export function getRunDetail(runId: string, after = -1): Promise<RunDetail> {
  return request(`/runs/${encodeURIComponent(runId)}/detail?after=${after}`);
}

export function getEvidence(
  runId: string,
): Promise<{ evidence: EvidenceItem[]; claims: ClaimItem[]; conflicts: ConflictItem[] }> {
  return request(`/runs/${encodeURIComponent(runId)}/evidence`);
}

export function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}
