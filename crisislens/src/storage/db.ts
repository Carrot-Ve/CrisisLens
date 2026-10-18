// SQLite 持久化：schema、迁移与连接。
// 选型依据：Node 22 内置 node:sqlite（DatabaseSync），零额外依赖，无需原生编译。
// 方言为 SQLite，不适用 sql-pro 参考里的 PostgreSQL 专属特性（EXCLUDE、tstzrange 等）。
//
// 三条硬设计约束，直接对应需求里的真实性要求：
//   1. events 主键为 (run_id, sequence) —— 重复回放同一事件会主键冲突而不是重复生效。
//      这是「中断恢复不重复应用事件」在存储层的保证，不依赖上层去重。
//   2. status 用 CHECK 约束限定枚举 —— 存储层就不可能写出「假成功」状态。
//   3. stop_reason / finished_at 允许 NULL —— 运行未结束时未知就是 NULL，
//      不给默认值，避免前端读到伪造的完成态。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id    TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  user_task  TEXT NOT NULL,
  entities   TEXT NOT NULL,
  questions  TEXT NOT NULL,
  budget     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  stop_reason    TEXT,
  error_message  TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE IF NOT EXISTS events (
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence  INTEGER NOT NULL,
  type      TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS evidence (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('public','internal')),
  excerpt      TEXT NOT NULL,
  quote        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS claims (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  claim_id       TEXT NOT NULL,
  statement      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open','confirmed','contested','inconclusive','unsupported')),
  links          TEXT NOT NULL,
  positive_terms TEXT NOT NULL,
  negative_terms TEXT NOT NULL,
  PRIMARY KEY (run_id, claim_id)
);

CREATE TABLE IF NOT EXISTS conflicts (
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  conflict_id     TEXT NOT NULL,
  claim_id        TEXT NOT NULL,
  supporting_ids  TEXT NOT NULL,
  contradicting_ids TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('unresolved','resolved')),
  PRIMARY KEY (run_id, conflict_id)
);

CREATE TABLE IF NOT EXISTS reports (
  run_id           TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('complete','partial')),
  stop_reason      TEXT,
  markdown         TEXT NOT NULL,
  missing_material TEXT NOT NULL,
  sections         TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
`;

// 索引：外键必建索引；复合索引按查询模式建（任务详情按时间倒序取运行）。
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task_started ON runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_evidence_run_source ON evidence(run_id, source_id);
CREATE INDEX IF NOT EXISTS idx_claims_run ON claims(run_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_run ON conflicts(run_id);
`;

export interface Db {
  raw: DatabaseSync;
  close(): void;
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  // SQLite 默认关闭外键约束，必须显式开启，否则 ON DELETE CASCADE 不生效。
  raw.exec('PRAGMA foreign_keys = ON');
  // WAL 让读（前端轮询/SSE）不阻塞写（运行中的事件写入）。
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(DDL);
  raw.exec(INDEXES);

  const version = raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (version === undefined) {
    raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }

  return {
    raw,
    close(): void {
      raw.close();
    },
  };
}
