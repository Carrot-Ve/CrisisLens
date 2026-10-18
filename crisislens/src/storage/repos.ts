// 仓储层：所有 SQL 集中在此，上层服务不拼 SQL。
// 遵守 sql-pro：外键均有索引、显式处理 NULL、不用 SELECT *、过滤条件下推到 SQL。
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BUDGET } from '../core/state.ts';
import type {
  Claim,
  ClaimStatus,
  Conflict,
  Evidence,
  InvestigationTask,
  RunBudget,
} from '../core/types.ts';
import type { AgentEvent } from '../runtime/events.ts';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  taskId: string;
  caseId: string;
  userTask: string;
  entities: string[];
  questions: unknown[];
  budget: RunBudget;
  createdAt: number;
}

export interface RunRecord {
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

export interface EventRecord {
  sequence: number;
  type: string;
  timestamp: number;
  payload: string;
}

export interface ReportRecord {
  runId: string;
  status: 'complete' | 'partial';
  stopReason: string | null;
  markdown: string;
  missingMaterial: string[];
  sections: { title: string; body: string }[];
  createdAt: number;
}

/** 任务列表项：带最新一次运行的摘要，用于列表页一眼看出状态。 */
export interface TaskListItem {
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

/**
 * 序列化为可绑定参数的 JSON 字符串。
 * 必须存在的原因：node:sqlite 只接受 null / number / bigint / string / Uint8Array 作参数，
 * 而 toJson(undefined) 返回 undefined（不是字符串），会直接抛
 * "Provided value cannot be bound to SQLite parameter N"。
 * 领域对象里可选字段（如 positiveTerms）缺失时正是这种情况。
 */
function toJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null';
}

/** 反序列化并兜底：库里存了 'null' 时给出类型安全的默认值。 */
function fromJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T | null;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function insertTask(db: DatabaseSync, task: InvestigationTask, createdAt: number): void {
  db.prepare(
    `INSERT INTO tasks (task_id, case_id, user_task, entities, questions, budget, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       user_task = excluded.user_task,
       entities  = excluded.entities,
       questions = excluded.questions,
       budget    = excluded.budget`,
  ).run(
    task.taskId,
    task.caseId,
    task.userTask,
    toJson(task.entities),
    toJson(task.questions),
    toJson(task.budget),
    createdAt,
  );
}

export function getTask(db: DatabaseSync, taskId: string): TaskRecord | null {
  const row = db
    .prepare('SELECT task_id, case_id, user_task, entities, questions, budget, created_at FROM tasks WHERE task_id = ?')
    .get(taskId) as
    | {
        task_id: string;
        case_id: string;
        user_task: string;
        entities: string;
        questions: string;
        budget: string;
        created_at: number;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    taskId: row.task_id,
    caseId: row.case_id,
    userTask: row.user_task,
    entities: fromJson<string[]>(row.entities, []),
    questions: fromJson<unknown[]>(row.questions, []),
    budget: fromJson<RunBudget>(row.budget, DEFAULT_BUDGET),
    createdAt: row.created_at,
  };
}

/**
 * 任务列表：用 LEFT JOIN 取每次任务的最新一次运行，避免 N+1 查询。
 * 过滤与排序都在 SQL 里完成，不把全表拉到 JS 再处理。
 */
export function listTasks(db: DatabaseSync, limit = 50): TaskListItem[] {
  const rows = db
    .prepare(
      `SELECT t.task_id, t.case_id, t.user_task, t.created_at,
              r.run_id, r.status, r.stop_reason, r.evidence_count, r.conflict_count
       FROM tasks t
       LEFT JOIN runs r ON r.run_id = (
         SELECT r2.run_id FROM runs r2
         WHERE r2.task_id = t.task_id
         ORDER BY r2.started_at DESC, r2.run_id DESC
         LIMIT 1
       )
       ORDER BY t.created_at DESC, t.task_id DESC
       LIMIT ?`,
    )
    .all(limit) as {
    task_id: string;
    case_id: string;
    user_task: string;
    created_at: number;
    run_id: string | null;
    status: RunStatus | null;
    stop_reason: string | null;
    evidence_count: number | null;
    conflict_count: number | null;
  }[];

  return rows.map((r) => ({
    taskId: r.task_id,
    caseId: r.case_id,
    userTask: r.user_task,
    createdAt: r.created_at,
    latestRunId: r.run_id,
    latestStatus: r.status,
    latestStopReason: r.stop_reason,
    evidenceCount: r.evidence_count ?? 0,
    conflictCount: r.conflict_count ?? 0,
  }));
}

export function insertRun(db: DatabaseSync, runId: string, taskId: string, startedAt: number): void {
  db.prepare('INSERT INTO runs (run_id, task_id, status, started_at) VALUES (?, ?, ?, ?)').run(
    runId,
    taskId,
    'running',
    startedAt,
  );
}

export function getRun(db: DatabaseSync, runId: string): RunRecord | null {
  const row = db
    .prepare(
      `SELECT run_id, task_id, status, stop_reason, error_message,
              started_at, finished_at, tool_calls, evidence_count, conflict_count
       FROM runs WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        run_id: string;
        task_id: string;
        status: RunStatus;
        stop_reason: string | null;
        error_message: string | null;
        started_at: number;
        finished_at: number | null;
        tool_calls: number;
        evidence_count: number;
        conflict_count: number;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    stopReason: row.stop_reason,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    toolCalls: row.tool_calls,
    evidenceCount: row.evidence_count,
    conflictCount: row.conflict_count,
  };
}

export function listRuns(db: DatabaseSync, taskId: string): RunRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, run_id DESC`,
    )
    .all(taskId) as { run_id: string }[];
  return rows.map((r) => getRun(db, r.run_id)).filter((r): r is RunRecord => r !== null);
}

/** 结束运行。stopReason 为 null 表示异常终止（失败/取消），不伪造原因。 */
export function finishRun(
  db: DatabaseSync,
  runId: string,
  status: Exclude<RunStatus, 'running'>,
  finishedAt: number,
  stopReason: string | null,
  errorMessage: string | null,
  counts: { toolCalls: number; evidenceCount: number; conflictCount: number },
): void {
  db.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, stop_reason = ?, error_message = ?,
         tool_calls = ?, evidence_count = ?, conflict_count = ?
     WHERE run_id = ?`,
  ).run(
    status,
    finishedAt,
    stopReason,
    errorMessage,
    counts.toolCalls,
    counts.evidenceCount,
    counts.conflictCount,
    runId,
  );
}

/**
 * 追加一条事件。
 * 幂等依据：主键 (run_id, sequence) + OR IGNORE。回放同一次运行的同一条事件
 * 不会产生第二行，也不会报错。返回 false 表示该事件此前已写入（重复回放命中）。
 */
export function appendEvent(db: DatabaseSync, runId: string, event: AgentEvent): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events (run_id, sequence, type, timestamp, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, event.sequence, event.type, event.timestamp, toJson(event));
  return result.changes > 0;
}

/** 增量读取事件，供 SSE 续传。afterSequence 为 -1 表示从头读。 */
export function listEvents(db: DatabaseSync, runId: string, afterSequence = -1, limit = 500): EventRecord[] {
  const rows = db
    .prepare(
      `SELECT sequence, type, timestamp, payload
       FROM events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(runId, afterSequence, limit) as {
    sequence: number;
    type: string;
    timestamp: number;
    payload: string;
  }[];
  return rows;
}

export function countEvents(db: DatabaseSync, runId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?').get(runId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * 用检查点快照刷新证据/结论/冲突。
 * 快照是当轮全量状态，用 UPSERT 而不是「先删后插」——避免删除窗口内前端读到空列表。
 */
export function replaceSnapshot(
  db: DatabaseSync,
  runId: string,
  snapshot: { evidence: Evidence[]; claims: Claim[]; conflicts: Conflict[] },
): void {
  db.exec('BEGIN');
  try {
    const evStmt = db.prepare(
      `INSERT INTO evidence (run_id, evidence_id, source_id, channel, excerpt, quote, content_hash, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, evidence_id) DO UPDATE SET
         source_id = excluded.source_id, channel = excluded.channel,
         excerpt = excluded.excerpt, quote = excluded.quote,
         content_hash = excluded.content_hash, retrieved_at = excluded.retrieved_at`,
    );
    for (const e of snapshot.evidence) {
      evStmt.run(runId, e.evidenceId, e.sourceId, e.channel, e.excerpt, e.quote, e.contentHash, e.retrievedAt);
    }

    const claimStmt = db.prepare(
      `INSERT INTO claims (run_id, claim_id, statement, status, links, positive_terms, negative_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, claim_id) DO UPDATE SET
         statement = excluded.statement, status = excluded.status, links = excluded.links,
         positive_terms = excluded.positive_terms, negative_terms = excluded.negative_terms`,
    );
    for (const c of snapshot.claims) {
      claimStmt.run(
        runId,
        c.claimId,
        c.statement,
        c.status,
        toJson(c.links),
        toJson(c.positiveTerms),
        toJson(c.negativeTerms),
      );
    }

    const conflictStmt = db.prepare(
      `INSERT INTO conflicts (run_id, conflict_id, claim_id, supporting_ids, contradicting_ids, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, conflict_id) DO UPDATE SET
         claim_id = excluded.claim_id, supporting_ids = excluded.supporting_ids,
         contradicting_ids = excluded.contradicting_ids, status = excluded.status`,
    );
    for (const c of snapshot.conflicts) {
      conflictStmt.run(
        runId,
        c.conflictId,
        c.claimId,
        toJson(c.supportingEvidenceIds),
        toJson(c.contradictingEvidenceIds),
        c.status,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listEvidence(db: DatabaseSync, runId: string): Evidence[] {
  const rows = db
    .prepare(
      `SELECT evidence_id, source_id, channel, excerpt, quote, content_hash, retrieved_at
       FROM evidence WHERE run_id = ? ORDER BY retrieved_at ASC, evidence_id ASC`,
    )
    .all(runId) as {
    evidence_id: string;
    source_id: string;
    channel: 'public' | 'internal';
    excerpt: string;
    quote: string;
    content_hash: string;
    retrieved_at: number;
  }[];
  return rows.map((r) => ({
    evidenceId: r.evidence_id,
    sourceId: r.source_id,
    channel: r.channel,
    excerpt: r.excerpt,
    quote: r.quote,
    contentHash: r.content_hash,
    retrievedAt: r.retrieved_at,
  }));
}

export interface ClaimRow {
  claimId: string;
  statement: string;
  status: ClaimStatus;
  links: { evidenceId: string; relation: string }[];
}

export function listClaims(db: DatabaseSync, runId: string): ClaimRow[] {
  const rows = db
    .prepare(
      `SELECT claim_id, statement, status, links FROM claims WHERE run_id = ? ORDER BY claim_id ASC`,
    )
    .all(runId) as { claim_id: string; statement: string; status: ClaimStatus; links: string }[];
  return rows.map((r) => ({
    claimId: r.claim_id,
    statement: r.statement,
    status: r.status,
    links: fromJson<{ evidenceId: string; relation: string }[]>(r.links, []),
  }));
}

export interface ConflictRow {
  conflictId: string;
  claimId: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  status: string;
}

export function listConflicts(db: DatabaseSync, runId: string): ConflictRow[] {
  const rows = db
    .prepare(
      `SELECT conflict_id, claim_id, supporting_ids, contradicting_ids, status
       FROM conflicts WHERE run_id = ? ORDER BY conflict_id ASC`,
    )
    .all(runId) as {
    conflict_id: string;
    claim_id: string;
    supporting_ids: string;
    contradicting_ids: string;
    status: string;
  }[];
  return rows.map((r) => ({
    conflictId: r.conflict_id,
    claimId: r.claim_id,
    supportingEvidenceIds: fromJson<string[]>(r.supporting_ids, []),
    contradictingEvidenceIds: fromJson<string[]>(r.contradicting_ids, []),
    status: r.status,
  }));
}

export function upsertReport(
  db: DatabaseSync,
  runId: string,
  report: { status: 'complete' | 'partial'; stopReason: string | null; markdown: string; missingMaterial: string[]; sections: { title: string; body: string }[] },
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO reports (run_id, status, stop_reason, markdown, missing_material, sections, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       status = excluded.status, stop_reason = excluded.stop_reason,
       markdown = excluded.markdown, missing_material = excluded.missing_material,
       sections = excluded.sections, created_at = excluded.created_at`,
  ).run(
    runId,
    report.status,
    report.stopReason,
    report.markdown,
    toJson(report.missingMaterial),
    toJson(report.sections),
    createdAt,
  );
}

export function getReport(db: DatabaseSync, runId: string): ReportRecord | null {
  const row = db
    .prepare(
      `SELECT run_id, status, stop_reason, markdown, missing_material, sections, created_at
       FROM reports WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        run_id: string;
        status: 'complete' | 'partial';
        stop_reason: string | null;
        markdown: string;
        missing_material: string;
        sections: string;
        created_at: number;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    runId: row.run_id,
    status: row.status,
    stopReason: row.stop_reason,
    markdown: row.markdown,
    missingMaterial: fromJson<string[]>(row.missing_material, []),
    sections: fromJson<{ title: string; body: string }[]>(row.sections, []),
    createdAt: row.created_at,
  };
}
