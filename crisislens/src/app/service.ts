// 应用服务层：任务生命周期与运行控制。
// 职责边界：本层不实现任何调查逻辑（那是 Agent Core 的事），只负责
//   1) 把任务规格转成 InvestigationTask；
//   2) 把 runtime 的 sink（事件）与 checkpoint（快照）接到 SQLite；
//   3) 管理运行句柄以支持取消；
//   4) 如实记录结束状态——失败就是 failed，不做成 completed。
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createFakeModel } from '../adapters/model/fake-model.ts';
import { createFixtureRunner, toToolPort } from '../adapters/tools/deterministic-tools.ts';
import { DEFAULT_BUDGET } from '../core/state.ts';
import type { InvestigationTask, Question } from '../core/types.ts';
import type { AgentEvent } from '../runtime/events.ts';
import { runInvestigation } from '../runtime/runtime.ts';
import type { RunSnapshot } from '../runtime/runtime.ts';
import {
  appendEvent,
  finishRun,
  getReport,
  getRun,
  getTask,
  insertRun,
  insertTask,
  listClaims,
  listConflicts,
  listEvidence,
  listEvents,
  listRuns,
  listTasks,
  replaceSnapshot,
  upsertReport,
} from '../storage/repos.ts';
import type {
  EventRecord,
  RunRecord,
  TaskListItem,
  TaskRecord,
} from '../storage/repos.ts';

export interface CreateTaskInput {
  caseId: string;
  userTask: string;
  entities: string[];
  questions: Question[];
}

export interface RunDetail {
  run: RunRecord;
  task: TaskRecord | null;
  events: EventRecord[];
  evidence: ReturnType<typeof listEvidence>;
  claims: ReturnType<typeof listClaims>;
  conflicts: ReturnType<typeof listConflicts>;
  report: ReturnType<typeof getReport>;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`任务不存在：${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`运行不存在：${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export interface InvestigationService {
  createTask(input: CreateTaskInput): TaskRecord;
  listTasks(limit?: number): TaskListItem[];
  getTask(taskId: string): TaskRecord | null;
  listRuns(taskId: string): RunRecord[];
  /** 启动一次运行。返回 runId，执行在后台进行，调用方通过 getRun 观察状态。 */
  startRun(taskId: string): Promise<string>;
  cancelRun(runId: string): boolean;
  getRun(runId: string): RunRecord | null;
  getRunDetail(runId: string, afterSequence?: number): RunDetail;
  getEventStream(runId: string, afterSequence?: number): EventRecord[];
  close(): void;
}

export function createInvestigationService(db: DatabaseSync, datasetRoot: string): InvestigationService {
  // 运行句柄：runId -> 取消控制器。仅存活在进程内，重启后不保留（本阶段不实现崩溃恢复）。
  const controllers = new Map<string, AbortController>();

  function buildTask(taskId: string, input: CreateTaskInput): InvestigationTask {
    const runner = createFixtureRunner(datasetRoot, input.caseId);
    return {
      taskId,
      caseId: input.caseId,
      userTask: input.userTask,
      entities: input.entities,
      questions: input.questions,
      budget: {
        ...DEFAULT_BUDGET,
        maxToolCalls: runner.manifest.budget.max_tool_calls,
        maxTokens: runner.manifest.budget.max_tokens,
        maxRetriesPerResource: runner.manifest.budget.max_retries_per_resource,
      },
    };
  }

  return {
    createTask(input) {
      const taskId = `task_${randomUUID().slice(0, 8)}`;
      const task = buildTask(taskId, input);
      const now = Date.now();
      insertTask(db, task, now);
      const record = getTask(db, taskId);
      if (record === null) throw new Error(`任务写入后读取失败：${taskId}`);
      return record;
    },

    listTasks(limit = 50) {
      return listTasks(db, 10000).filter(task => task.caseId !== 'live').slice(0, limit);
    },

    getTask(taskId) {
      return getTask(db, taskId);
    },

    listRuns(taskId) {
      return listRuns(db, taskId);
    },

    async startRun(taskId) {
      const record = getTask(db, taskId);
      if (record === null) throw new TaskNotFoundError(taskId);
      if (record.caseId === 'live') throw new Error('真实调查任务请使用对话入口，不能启动模拟模型');

      const runId = `run_${randomUUID().slice(0, 8)}`;
      const task: InvestigationTask = {
        taskId: record.taskId,
        caseId: record.caseId,
        userTask: record.userTask,
        entities: record.entities,
        questions: record.questions as Question[],
        budget: record.budget,
      };

      const controller = new AbortController();
      controllers.set(runId, controller);
      insertRun(db, runId, taskId, Date.now());

      const runner = createFixtureRunner(datasetRoot, task.caseId);
      let lastSnapshot: RunSnapshot | null = null;

      // 后台执行：不 await，让前端可以边跑边看。
      void (async () => {
        try {
          const outcome = await runInvestigation(
            task,
            {
              model: createFakeModel(),
              tools: toToolPort(runner),
              sink: {
                write(event: AgentEvent): void {
                  // 事件逐条落库；主键 (run_id, sequence) 保证重复回放不会重复生效。
                  appendEvent(db, runId, event);
                },
                close(): void {
                  // 事件写入与 DB 连接同生命周期，无需额外关闭动作。
                },
              },
              checkpoint: (snapshot: RunSnapshot): void => {
                lastSnapshot = snapshot;
                replaceSnapshot(db, runId, {
                  evidence: snapshot.evidence as never,
                  claims: snapshot.claims as never,
                  conflicts: snapshot.conflicts as never,
                });
              },
            },
            { runId, signal: controller.signal },
          );

          upsertReport(
            db,
            runId,
            {
              status: outcome.report.status,
              stopReason: outcome.report.stopReason,
              markdown: outcome.report.markdown,
              missingMaterial: outcome.report.missingMaterial,
              sections: outcome.report.sections,
            },
            Date.now(),
          );
          finishRun(db, runId, 'completed', Date.now(), outcome.stopReason, null, {
            toolCalls: runner.trace.length,
            evidenceCount: listEvidence(db, runId).length,
            conflictCount: listConflicts(db, runId).length,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const cancelled = controller.signal.aborted;
          // 取消与失败分开设状态，不把取消包装成成功。
          finishRun(db, runId, cancelled ? 'cancelled' : 'failed', Date.now(), null, message, {
            toolCalls: runner.trace.length,
            evidenceCount: listEvidence(db, runId).length,
            conflictCount: listConflicts(db, runId).length,
          });
        } finally {
          controllers.delete(runId);
          void lastSnapshot;
        }
      })();

      return runId;
    },

    cancelRun(runId) {
      const controller = controllers.get(runId);
      if (controller === undefined) return false;
      controller.abort();
      return true;
    },

    getRun(runId) {
      return getRun(db, runId);
    },

    getRunDetail(runId, afterSequence = -1) {
      const run = getRun(db, runId);
      if (run === null) throw new RunNotFoundError(runId);
      return {
        run,
        task: getTask(db, run.taskId),
        events: listEvents(db, runId, afterSequence),
        evidence: listEvidence(db, runId),
        claims: listClaims(db, runId),
        conflicts: listConflicts(db, runId),
        report: getReport(db, runId),
      };
    },

    getEventStream(runId, afterSequence = -1) {
      return listEvents(db, runId, afterSequence);
    },

    close() {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };
}
