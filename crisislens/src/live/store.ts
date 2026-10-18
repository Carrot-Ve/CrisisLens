import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BUDGET } from '../core/state.ts';
import { getTask, insertTask, listTasks } from '../storage/repos.ts';
import type { ChatMessage, WebSource } from './types.ts';

export function createLiveStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_tasks (
      task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
      client_id TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      run_id TEXT REFERENCES runs(run_id), UNIQUE(task_id,client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_task_seq ON messages(task_id,seq);
    CREATE TABLE IF NOT EXISTS web_sources (
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id),
      url TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      retrieved_at INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(task_id,source_id)
    );
    INSERT INTO meta(key,value) VALUES('live_schema_version','1') ON CONFLICT(key) DO NOTHING;
  `);
  const messages = (taskId: string): ChatMessage[] => db.prepare(`SELECT id,task_id AS taskId,role,content,created_at AS createdAt,run_id AS runId,seq FROM messages WHERE task_id=? ORDER BY seq`).all(taskId) as unknown as ChatMessage[];
  const requireTask = (taskId: string) => {
    if (!db.prepare('SELECT task_id FROM live_tasks WHERE task_id=?').get(taskId)) throw new Error('任务不存在');
    return getTask(db, taskId)!;
  };
  return {
    requireTask, messages,
    createTask(title: string, clientId: string) {
      const existing = db.prepare('SELECT task_id FROM live_tasks WHERE client_id=?').get(clientId) as { task_id: string } | undefined;
      if (existing) return requireTask(existing.task_id);
      const taskId = `task_${randomUUID()}`;
      db.exec('BEGIN');
      try {
        insertTask(db, { taskId, caseId: 'live', userTask: title, entities: [], questions: [], budget: { ...DEFAULT_BUDGET, maxToolCalls: 12, timeoutMs: 600000 } }, Date.now());
        db.prepare('INSERT INTO live_tasks VALUES(?,?,?)').run(taskId, clientId, Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return requireTask(taskId);
    },
    listTasks() {
      const recent = db.prepare('SELECT task_id FROM live_tasks ORDER BY updated_at DESC LIMIT 100').all() as { task_id: string }[];
      const summaries = new Map(listTasks(db, 10000).map(t => [t.taskId, t]));
      return recent.map(t => summaries.get(t.task_id)!);
    },
    addMessage(taskId: string, role: ChatMessage['role'], content: string, clientId: string, runId: string | null = null): ChatMessage {
      requireTask(taskId);
      db.prepare(`INSERT INTO messages(id,task_id,role,content,client_id,created_at,run_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,client_id) DO NOTHING`).run(randomUUID(), taskId, role, content, clientId, Date.now(), runId);
      db.prepare('UPDATE live_tasks SET updated_at=? WHERE task_id=?').run(Date.now(), taskId);
      return messages(taskId).find(m => m.id === (db.prepare('SELECT id FROM messages WHERE task_id=? AND client_id=?').get(taskId,clientId) as {id:string}).id)!;
    },
    bindPending(taskId: string, runId: string) {
      db.prepare("UPDATE messages SET run_id=? WHERE task_id=? AND role='user' AND run_id IS NULL").run(runId, taskId);
    },
    sources(taskId: string): WebSource[] {
      return db.prepare('SELECT source_id AS id,run_id AS runId,url,title,content,retrieved_at AS retrievedAt,hash FROM web_sources WHERE task_id=? ORDER BY retrieved_at,source_id').all(taskId) as unknown as WebSource[];
    },
    saveSource(taskId: string, runId: string, page: {url:string;title:string;content:string}): WebSource {
      const count = db.prepare('SELECT COUNT(*) AS n FROM web_sources WHERE task_id=?').get(taskId) as {n:number};
      const source = { ...page, id: `S${count.n + 1}`, runId, retrievedAt: Date.now(), hash: createHash('sha256').update(page.content).digest('hex') };
      db.prepare('INSERT INTO web_sources(task_id,source_id,run_id,url,title,content,retrieved_at,hash) VALUES(?,?,?,?,?,?,?,?)').run(taskId,source.id,runId,source.url,source.title,source.content,source.retrievedAt,source.hash);
      return source;
    },
    event(runId: string, type: string, payload: Record<string,unknown>) {
      const seq = (db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM events WHERE run_id=?').get(runId) as {n:number}).n;
      const timestamp = Date.now();
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(runId,seq,type,timestamp,JSON.stringify({ ...payload, type, timestamp, sequence:seq, runId }));
    },
    recover() {
      db.prepare("UPDATE runs SET status='failed',finished_at=?,error_message='服务重启导致调查中断，请发送消息重试',stop_reason='interrupted' WHERE status='running' AND task_id IN (SELECT task_id FROM live_tasks)").run(Date.now());
    },
  };
}
