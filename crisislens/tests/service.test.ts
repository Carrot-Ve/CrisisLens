// 应用服务层验证：创建任务 → 启动运行 → 事件落库 → 证据/结论/报告可读。
// 这是阶段 4 前端所依赖的后端契约，先在此处证明成立。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationService } from '../src/app/service.ts';
import type { InvestigationService } from '../src/app/service.ts';
import { openDb } from '../src/storage/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const datasetRoot = resolve(packageRoot, '..', 'crisislens_dataset');

/**
 * 复用 tasks/ 下的真实任务规格。
 * 必须用真实规格的原因：阶段 1 的假模型靠 positiveTerms/negativeTerms 判断证据取向，
 * 只给问题文本不给判据措辞时它无法匹配——那是夹具模型的能力边界，不是产品缺陷。
 */
function loadQuestions(caseId: string): { id: string; text: string; status: 'open'; positiveTerms?: string[]; negativeTerms?: string[] }[] {
  const spec = JSON.parse(readFileSync(resolve(packageRoot, 'tasks', `${caseId}.json`), 'utf8')) as {
    questions: { id: string; text: string; positiveTerms?: string[]; negativeTerms?: string[] }[];
  };
  return spec.questions.map((q) => ({ ...q, status: 'open' as const }));
}

let dir: string;
let handle: ReturnType<typeof openDb>;
let service: InvestigationService;

/** 轮询等待运行结束（假模型为毫秒级，这里只做有上限的等待）。 */
async function waitForRun(runId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (run !== null && run.status !== 'running') return run.status;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`运行 ${runId} 在 ${timeoutMs}ms 内未结束`);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'crisislens-svc-'));
  handle = openDb(join(dir, 'app.db'));
  service = createInvestigationService(handle.raw, datasetRoot);
});

after(() => {
  service.close();
  // 必须先关 DB 再删目录，否则 Windows 上 WAL 文件句柄未释放会 EBUSY。
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('应用服务层', () => {
  it('创建任务后可读回完整规格', () => {
    const task = service.createTask({
      caseId: 'food_foreign_object_001',
      userTask: '调查青禾酥饼异物反馈事件',
      entities: ['青禾酥饼'],
      questions: [
        { id: 'Q1', text: '是否存在消费者异物反馈记录？', status: 'open' },
        { id: 'Q2', text: '反馈记录是否涉及批次 B？', status: 'open' },
      ],
    });
    const back = service.getTask(task.taskId);
    assert.ok(back);
    assert.equal(back?.caseId, 'food_foreign_object_001');
    assert.equal(back?.questions.length, 2);
  });

  it('启动一次运行后事件、证据、报告全部落库', async () => {
    const task = service.createTask({
      caseId: 'food_foreign_object_001',
      userTask: '调查青禾酥饼异物反馈事件',
      entities: ['青禾酥饼'],
      questions: loadQuestions('food_foreign_object_001'),
    });
    const runId = await service.startRun(task.taskId);
    const status = await waitForRun(runId);
    assert.equal(status, 'completed');

    const run = service.getRun(runId);
    assert.equal(run?.status, 'completed');
    assert.ok(run?.stopReason, '结束必须写明停止原因，不能为空');
    assert.ok(run?.finishedAt !== null);

    const detail = service.getRunDetail(runId);
    assert.ok(detail.events.length > 0, '事件必须落库');
    assert.ok(detail.evidence.length > 0, '证据必须落库');
    assert.ok(detail.report, '报告必须落库');
    assert.ok(detail.report?.markdown.includes('调查报告'));
  });

  it('证据带有稳定来源标识，可支撑引用', async () => {
    const task = service.createTask({
      caseId: 'food_foreign_object_001',
      userTask: '调查异物事件',
      entities: ['青禾酥饼'],
      questions: loadQuestions('food_foreign_object_001'),
    });
    const runId = await service.startRun(task.taskId);
    await waitForRun(runId);
    const detail = service.getRunDetail(runId);
    for (const e of detail.evidence) {
      assert.ok(e.sourceId.length > 0, '每条证据必须有 sourceId');
      assert.ok(e.quote.length > 0, '每条证据必须有引文');
    }
    const sources = new Set(detail.evidence.map((e) => e.sourceId));
    assert.ok(sources.size > 0);
  });

  it('判据措辞缺失时不伪造证据，如实给出有限结果', async () => {
    // 只给问题文本、不给 positiveTerms/negativeTerms：假模型无从匹配，
    // 正确行为是产出 0 证据的部分报告，而不是编造证据或假装成功。
    const task = service.createTask({
      caseId: 'food_foreign_object_001',
      userTask: '调查异物事件（无判据措辞）',
      entities: ['青禾酥饼'],
      questions: [{ id: 'QX', text: '某个无法判定的问题？', status: 'open' }],
    });
    const runId = await service.startRun(task.taskId);
    const status = await waitForRun(runId);
    assert.equal(status, 'completed', '运行本身应正常结束，不是崩溃');

    const detail = service.getRunDetail(runId);
    assert.equal(detail.evidence.length, 0, '无判据措辞时不应产出证据');
    assert.ok(detail.report, '仍然必须产出报告');
    assert.equal(detail.report?.status, 'partial', '证据不足时报告状态必须是 partial，不能是 complete');
    assert.ok(detail.report?.missingMaterial.length ?? 0 > 0, '必须写明缺什么材料');
    assert.ok(detail.events.length > 0, '事件流仍然完整，便于追溯为何没有证据');
  });

  it('任务不存在时启动运行抛错而不是静默成功', async () => {
    await assert.rejects(() => service.startRun('task_nonexistent'), /任务不存在/);
  });

  it('运行不存在时查询详情抛错', () => {
    assert.throws(() => service.getRunDetail('run_nonexistent'), /运行不存在/);
  });

  it('任务列表能带出最新运行摘要', async () => {
    const task = service.createTask({
      caseId: 'food_foreign_object_001_conflict',
      userTask: '调查冲突场景',
      entities: ['青禾酥饼'],
      questions: [{ id: 'Q2', text: '反馈记录是否涉及批次 B？', status: 'open' }],
    });
    const runId = await service.startRun(task.taskId);
    await waitForRun(runId);
    const items = service.listTasks(10);
    const found = items.find((i) => i.taskId === task.taskId);
    assert.ok(found);
    assert.equal(found?.latestRunId, runId);
    assert.equal(found?.latestStatus, 'completed');
  });
});
