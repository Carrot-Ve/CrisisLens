// 存储层验证。重点验证三条硬约束：事件幂等、外键级联、CHECK 拒绝非法状态。
// 这些是阶段 3「恢复不重复应用事件」与「不伪造成功」在存储层的证据。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BUDGET } from '../src/core/state.ts';
import type { AgentEvent } from '../src/runtime/events.ts';
import type { Evidence } from '../src/core/types.ts';
import { openDb } from '../src/storage/db.ts';
import {
  appendEvent,
  countEvents,
  getReport,
  getRun,
  getTask,
  insertRun,
  insertTask,
  listConflicts,
  listEvidence,
  listEvents,
  listTasks,
  replaceSnapshot,
  upsertReport,
  finishRun,
} from '../src/storage/repos.ts';

let dir: string;
let db: DatabaseSync;

const TASK = {
  taskId: 'task_t1',
  caseId: 'food_foreign_object_001',
  userTask: '调查异物反馈事件',
  entities: ['青禾酥饼'],
  questions: [{ id: 'Q1', text: '是否有反馈记录？', status: 'open' as const }],
  budget: DEFAULT_BUDGET,
};

function event(sequence: number): AgentEvent {
  return {
    sequence,
    runId: 'run_r1',
    timestamp: 1000 + sequence,
    type: 'tool_started',
    tool: 'search_sources',
    args: {},
  } as unknown as AgentEvent;
}

const EVIDENCE: Evidence[] = [
  {
    evidenceId: 'E001',
    sourceId: 'complaint_001',
    channel: 'public',
    excerpt: '用户自述批次 A 异物',
    quote: '发现疑似金属片',
    contentHash: 'h1',
    retrievedAt: 1000,
  },
];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'crisislens-db-'));
  db = openDb(join(dir, 'test.db')).raw;
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLite 存储层', () => {
  it('建表并写入任务与运行', () => {
    insertTask(db, TASK, 1000);
    insertRun(db, 'run_r1', 'task_t1', 1001);
    const task = getTask(db, 'task_t1');
    const run = getRun(db, 'run_r1');
    assert.ok(task);
    assert.equal(task?.caseId, 'food_foreign_object_001');
    assert.ok(run);
    assert.equal(run?.status, 'running');
    // 未结束时未知字段必须是 NULL，不能是伪造值
    assert.equal(run?.finishedAt, null);
    assert.equal(run?.stopReason, null);
  });

  it('重复追加同一事件不会产生第二行（幂等）', () => {
    assert.equal(appendEvent(db, 'run_r1', event(1)), true);
    assert.equal(appendEvent(db, 'run_r1', event(1)), false, '第二次应命中主键冲突并忽略');
    assert.equal(appendEvent(db, 'run_r1', event(2)), true);
    assert.equal(countEvents(db, 'run_r1'), 2, '事件总数必须是 2，不能重复累计');
    assert.equal(listEvents(db, 'run_r1', 1).length, 1, '增量读取应只返回 sequence>1 的');
  });

  it('CHECK 约束拒绝非法运行状态', () => {
    assert.throws(
      () => {
        db.prepare('INSERT INTO runs (run_id, task_id, status, started_at) VALUES (?,?,?,?)').run(
          'run_bad',
          'task_t1',
          'success',
          1,
        );
      },
      /CHECK|constraint/i,
    );
  });

  it('快照 UPSERT 重复调用不产生重复证据', () => {
    const snapshot = {
      evidence: EVIDENCE,
      claims: [
        {
          claimId: 'Q1',
          statement: '是否有反馈记录？',
          links: [{ evidenceId: 'E001', relation: 'supports' as const }],
          status: 'confirmed' as const,
          positiveTerms: ['异物'],
          negativeTerms: [],
        },
      ],
      conflicts: [],
    };
    replaceSnapshot(db, 'run_r1', snapshot);
    replaceSnapshot(db, 'run_r1', snapshot);
    assert.equal(listEvidence(db, 'run_r1').length, 1, '重复写入快照不得让证据翻倍');
    assert.equal(listConflicts(db, 'run_r1').length, 0);
  });

  it('结束运行后报告可读且状态一致', () => {
    finishRun(db, 'run_r1', 'completed', 2000, 'goal_complete', null, {
      toolCalls: 9,
      evidenceCount: 1,
      conflictCount: 0,
    });
    upsertReport(
      db,
      'run_r1',
      {
        status: 'partial',
        stopReason: 'partial_delivery',
        markdown: '# 报告',
        missingMaterial: ['批次 B 无质检结论'],
        sections: [{ title: '事实摘要', body: 'x' }],
      },
      2001,
    );
    const run = getRun(db, 'run_r1');
    assert.equal(run?.status, 'completed');
    assert.equal(run?.stopReason, 'goal_complete');
    const report = getReport(db, 'run_r1');
    assert.equal(report?.status, 'partial');
    assert.equal(report?.missingMaterial.length, 1);
  });

  it('任务列表带出最新运行摘要', () => {
    const items = listTasks(db, 10);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.latestRunId, 'run_r1');
    assert.equal(items[0]?.latestStatus, 'completed');
    assert.equal(items[0]?.evidenceCount, 1);
  });

  it('删除任务级联删除运行与事件', () => {
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run('task_t1');
    assert.equal(getRun(db, 'run_r1'), null, '外键 ON DELETE CASCADE 未生效');
    assert.equal(countEvents(db, 'run_r1'), 0, '事件应随运行级联删除');
    assert.equal(listTasks(db, 10).length, 0);
  });
});
