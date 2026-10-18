// 产品级事件。UI、CLI、trace writer 和测试消费这些事件；
// 原始 SDK 回调不得成为产品契约。
import type { Decision } from '../core/ports.ts';
import type { StopReason } from '../core/stop.ts';
import type { ToolErrorCode, ToolName } from '../core/types.ts';

export type RunErrorCode =
  | 'budget_tool_calls'
  | 'budget_iterations'
  | 'no_progress'
  | 'timeout'
  | 'cancelled'
  | 'provider_unavailable'
  | 'invalid_tool'
  | 'runtime_error';

export type AgentEvent =
  | { type: 'run_started'; runId: string; sequence: number; timestamp: number; caseId: string }
  | { type: 'state_initialized'; runId: string; sequence: number; timestamp: number; objective: string; questionIds: string[] }
  | { type: 'context_built'; runId: string; sequence: number; timestamp: number; chars: number; evidenceCount: number }
  | { type: 'model_requested'; runId: string; sequence: number; timestamp: number; model: string; purpose: 'decide' | 'interpret' }
  | { type: 'decision_made'; runId: string; sequence: number; timestamp: number; decision: Decision }
  | { type: 'tool_started'; runId: string; sequence: number; timestamp: number; tool: ToolName; args: Record<string, unknown>; attempt: number }
  | { type: 'tool_completed'; runId: string; sequence: number; timestamp: number; tool: ToolName; status: ToolErrorCode; durationMs: number; resourceId?: string }
  | { type: 'permission_checked'; runId: string; sequence: number; timestamp: number; tool: ToolName; resourceId: string; outcome: 'allow' | 'deny' }
  | { type: 'recovery_decision'; runId: string; sequence: number; timestamp: number; tool: ToolName; code: ToolErrorCode; action: 'retry' | 'no_retry' | 'backoff'; attempt: number }
  | { type: 'evidence_created'; runId: string; sequence: number; timestamp: number; evidenceId: string; sourceId: string; quote: string }
  | { type: 'claim_updated'; runId: string; sequence: number; timestamp: number; claimId: string; status: string; relations: string[] }
  | { type: 'conflict_detected'; runId: string; sequence: number; timestamp: number; conflictId: string; claimId: string }
  | { type: 'question_updated'; runId: string; sequence: number; timestamp: number; questionId: string; status: string }
  | { type: 'plan_updated'; runId: string; sequence: number; timestamp: number; stepId: string; text: string; triggeredBy: string }
  | { type: 'state_updated'; runId: string; sequence: number; timestamp: number; toolCallsUsed: number; noProgressCount: number }
  | { type: 'stop_evaluated'; runId: string; sequence: number; timestamp: number; shouldStop: boolean; reason: StopReason | null; details: string[] }
  | { type: 'checkpoint_saved'; runId: string; sequence: number; timestamp: number; path: string }
  | { type: 'usage_reported'; runId: string; sequence: number; timestamp: number; toolCalls: number; iterations: number; durationMs: number; model: string }
  | { type: 'report_generated'; runId: string; sequence: number; timestamp: number; status: 'complete' | 'partial'; missingMaterial: string[] }
  | { type: 'run_completed'; runId: string; sequence: number; timestamp: number; status: 'complete' | 'partial'; stopReason: StopReason | null }
  | { type: 'run_failed'; runId: string; sequence: number; timestamp: number; error: { code: RunErrorCode; message: string } }
  | { type: 'run_cancelled'; runId: string; sequence: number; timestamp: number };

export type AgentEventType = AgentEvent['type'];
