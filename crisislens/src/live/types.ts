export interface Citation { sourceId: string; quote: string }
export type Decision =
  | { action: 'search'; query: string; text?: string }
  | { action: 'read'; url: string; text?: string }
  | { action: 'clarify'; text: string }
  | { action: 'answer'; text: string; citations: Citation[] };
export interface Usage { inputTokens: number; outputTokens: number; durationMs: number }
export interface ChatMessage { id: string; taskId: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number; runId: string | null; seq: number }
export interface WebSource { id: string; runId: string; url: string; title: string; content: string; retrievedAt: number; hash: string }
export interface SearchHit { url: string; title: string; snippet: string }
export interface ModelContext { objective: string; messages: { role: string; content: string }[]; sources: WebSource[]; observations: string[]; remainingSteps: number; date: string }
export interface ModelStatus { connected: boolean; model: string; models: string[]; error?: string }
export interface LiveModel {
  name: string;
  decide(input: ModelContext, signal: AbortSignal): Promise<{ decision: Decision; usage: Usage }>;
  status(): Promise<ModelStatus>;
}
export interface WebTools {
  search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
  read(url: string, signal: AbortSignal): Promise<{ url: string; title: string; content: string }>;
}
