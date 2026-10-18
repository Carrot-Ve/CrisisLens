// append-only 事件日志。日志是 run 的唯一真相来源，快照只是缓存。
// sequence 每 run 单调递增；回放按 sequence 顺序应用，且必须幂等。
import type { AgentEvent } from './events.ts';

// 对联合类型必须分配式 Omit，否则 Omit<Union, K> 会塌缩成公共字段。
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** 写入日志时只需提供业务字段，sequence 与 timestamp 由日志自己分配。 */
export type EventDraft = DistributiveOmit<AgentEvent, 'sequence' | 'timestamp'>;

export interface EventLog {
  append(event: EventDraft): AgentEvent;
  list(): AgentEvent[];
  readonly runId: string;
}

export interface EventSink {
  write(event: AgentEvent): void;
  close(): void;
}

export function createEventLog(runId: string, sink?: EventSink): EventLog {
  const events: AgentEvent[] = [];
  let sequence = 0;
  return {
    runId,
    append(event) {
      const full = {
        ...event,
        sequence: ++sequence,
        timestamp: Date.now(),
      } as unknown as AgentEvent;
      events.push(full);
      sink?.write(full);
      return full;
    },
    list() {
      return events.slice();
    },
  };
}

/**
 * 幂等重放：按顺序应用事件重建“已发生什么”。
 * 这里只重建可观测摘要（工具调用、证据、冲突、停止），
 * 完整 AgentState 的恢复属于阶段 3 的 checkpoint 能力，本阶段不宣称已实现。
 */
export interface ReplaySummary {
  toolCalls: { tool: string; status: string; resourceId?: string }[];
  evidenceIds: string[];
  conflictIds: string[];
  stopReason: string | null;
  terminal: 'complete' | 'partial' | 'failed' | 'cancelled' | null;
}

export function replay(events: AgentEvent[]): ReplaySummary {
  const ordered = events.slice().sort((a, b) => a.sequence - b.sequence);
  const summary: ReplaySummary = {
    toolCalls: [],
    evidenceIds: [],
    conflictIds: [],
    stopReason: null,
    terminal: null,
  };
  for (const event of ordered) {
    switch (event.type) {
      case 'tool_completed':
        summary.toolCalls.push({
          tool: event.tool,
          status: event.status,
          ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        });
        break;
      case 'evidence_created':
        if (!summary.evidenceIds.includes(event.evidenceId)) summary.evidenceIds.push(event.evidenceId);
        break;
      case 'conflict_detected':
        if (!summary.conflictIds.includes(event.conflictId)) summary.conflictIds.push(event.conflictId);
        break;
      case 'stop_evaluated':
        summary.stopReason = event.reason;
        break;
      case 'run_completed':
        summary.terminal = event.status;
        break;
      case 'run_failed':
        summary.terminal = 'failed';
        break;
      case 'run_cancelled':
        summary.terminal = 'cancelled';
        break;
      default:
        break;
    }
  }
  return summary;
}
