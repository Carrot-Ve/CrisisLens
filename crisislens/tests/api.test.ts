// HTTP API 验证。测试内部启动真实服务（端口由系统分配），走真实 HTTP，不 mock。
// 重点验证：错误路径返回 4xx 且带 error；已完成运行的取消返回 409 而非假装成功。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createInvestigationService } from '../src/app/service.ts';
import type { InvestigationService } from '../src/app/service.ts';
import { openDb } from '../src/storage/db.ts';
import { listen } from '../src/server/http.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const datasetRoot = resolve(packageRoot, '..', 'crisislens_dataset');

let dir: string;
let handle: ReturnType<typeof openDb>;
let service: InvestigationService;
let server: Server;
let base: string;

function loadQuestions(): unknown[] {
  const spec = JSON.parse(
    readFileSync(resolve(packageRoot, 'tasks', 'food_foreign_object_001.json'), 'utf8'),
  ) as { questions: unknown[] };
  return spec.questions;
}

async function waitForRun(runId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/runs/${runId}`);
    const body = (await res.json()) as { run: { status: string } };
    if (body.run.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('运行未在超时内结束');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crisislens-api-'));
  handle = openDb(join(dir, 'app.db'));
  service = createInvestigationService(handle.raw, datasetRoot);
  const started = await listen(service, {
    port: 0,
    host: '127.0.0.1',
    webRoot: null,
    tasksRoot: resolve(packageRoot, 'tasks'),
    datasetRoot,
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  service.close();
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HTTP API', () => {
  it('任务列表初始为空', async () => {
    const res = await fetch(`${base}/api/tasks`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: unknown[] };
    assert.equal(body.tasks.length, 0);
  });

  it('/api/cases 同时列出基础事件族与挑战变体', async () => {
    const res = await fetch(`${base}/api/cases`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      cases: { caseId: string; kind: string; label: string; questions: unknown[] }[];
    };
    const baseline = body.cases.filter((c) => c.kind === 'baseline');
    const challenge = body.cases.filter((c) => c.kind === 'challenge');
    assert.equal(baseline.length, 1, '应恰好有一个基础事件族');
    assert.ok(challenge.length >= 7, `挑战变体应至少 7 个，实际 ${challenge.length}`);
    // 基线排在最前，便于界面默认选中
    assert.equal(body.cases[0]?.kind, 'baseline');
    for (const c of body.cases) {
      assert.ok(typeof c.label === 'string' && c.label.length > 0, `${c.caseId} 缺少展示名`);
      assert.ok(c.questions.length > 0, `${c.caseId} 缺少默认调查问题措辞`);
    }
  });

  it('挑战变体 caseId 能真正启动并完成运行，而不是只有列表项', async () => {
    const casesRes = await fetch(`${base}/api/cases`);
    const casesBody = (await casesRes.json()) as {
      cases: { caseId: string; kind: string; userTask: string; entities: string[] }[];
    };
    const variant = casesBody.cases.find((c) => c.caseId === 'food_foreign_object_001_conflict');
    assert.ok(variant !== undefined, '列表里应存在 conflict 变体');

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caseId: variant.caseId,
        userTask: variant.userTask,
        entities: variant.entities,
        questions: loadQuestions(),
      }),
    });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { taskId: string } };

    const started = await fetch(`${base}/api/tasks/${task.taskId}/runs`, { method: 'POST' });
    // 202 = 已接受并在后台执行；尚未完成，不能返回 200 假装成功
    assert.ok([201, 202].includes(started.status), `启动运行返回了意外状态 ${started.status}`);
    const { runId } = (await started.json()) as { runId: string };
    await waitForRun(runId);

    const detailRes = await fetch(`${base}/api/runs/${runId}/detail`);
    const detail = (await detailRes.json()) as { run: { status: string; errorMessage: string | null } };
    assert.equal(
      detail.run.status,
      'completed',
      `冲突变体应能跑完而不是失败：${detail.run.errorMessage ?? ''}`,
    );
  });

  it('缺少必填字段时返回 400 而不是创建任务', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userTask: '没有 caseId' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('caseId'));
  });

  it('创建任务返回 201 且可回查', async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caseId: 'food_foreign_object_001',
        userTask: '调查青禾酥饼异物反馈事件',
        entities: ['青禾酥饼'],
        questions: loadQuestions(),
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { task: { taskId: string } };
    assert.ok(body.task.taskId.startsWith('task_'));

    const back = await fetch(`${base}/api/tasks/${body.task.taskId}`);
    assert.equal(back.status, 200);
  });

  it('对不存在的任务启动运行返回 404', async () => {
    const res = await fetch(`${base}/api/tasks/task_none/runs`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('任务不存在'));
  });

  it('完整链路：创建 → 运行 → 详情 → 证据 → 报告', async () => {
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caseId: 'food_foreign_object_001',
        userTask: '调查青禾酥饼异物反馈事件',
        entities: ['青禾酥饼'],
        questions: loadQuestions(),
      }),
    });
    const { task } = (await created.json()) as { task: { taskId: string } };

    const started = await fetch(`${base}/api/tasks/${task.taskId}/runs`, { method: 'POST' });
    assert.equal(started.status, 202);
    const { runId } = (await started.json()) as { runId: string };

    await waitForRun(runId);

    const detailRes = await fetch(`${base}/api/runs/${runId}/detail`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as {
      run: { status: string; stopReason: string | null };
      events: unknown[];
      evidence: { sourceId: string; quote: string }[];
      report: { status: string; markdown: string } | null;
    };
    assert.equal(detail.run.status, 'completed');
    assert.ok(detail.run.stopReason, '停止原因必须可读');
    assert.ok(detail.events.length > 0);
    assert.ok(detail.evidence.length > 0);
    assert.ok(detail.report);
    assert.equal(detail.report?.status, 'partial');

    const evRes = await fetch(`${base}/api/runs/${runId}/evidence`);
    const ev = (await evRes.json()) as { evidence: { sourceId: string }[]; claims: unknown[] };
    assert.ok(ev.evidence.length > 0);
    assert.ok(ev.claims.length > 0);

    const repRes = await fetch(`${base}/api/runs/${runId}/report`);
    const rep = (await repRes.json()) as { report: { markdown: string } };
    assert.ok(rep.report.markdown.includes('调查报告'));
  });

  it('查询不存在的运行返回 404', async () => {
    const res = await fetch(`${base}/api/runs/run_none`);
    assert.equal(res.status, 404);
  });

  it('取消已结束的运行返回 409，不假装成功', async () => {
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caseId: 'food_foreign_object_001',
        userTask: '调查异物事件',
        entities: ['青禾酥饼'],
        questions: loadQuestions(),
      }),
    });
    const { task } = (await created.json()) as { task: { taskId: string } };
    const started = await fetch(`${base}/api/tasks/${task.taskId}/runs`, { method: 'POST' });
    const { runId } = (await started.json()) as { runId: string };
    await waitForRun(runId);

    const res = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(res.status, 409, '已结束的运行不能被取消，也不能返回成功');
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('无法取消'));
  });

  it('未知接口返回 404 而不是 200 空响应', async () => {
    const res = await fetch(`${base}/api/unknown`);
    assert.equal(res.status, 404);
  });
});
