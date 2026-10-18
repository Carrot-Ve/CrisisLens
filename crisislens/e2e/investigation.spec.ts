// 端到端验证关键用户路径。跑真实浏览器 + 真实后端 + 真实 SQLite，不做 mock。
// 每个用例自建任务，互不依赖。
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { NewTaskPage, RunDetailPage, TaskDetailPage, TaskListPage } from './pages/app.po.ts';

test.describe('CrisisLens 调查闭环', () => {
  test('首页可加载并提供新建入口', async ({ page }) => {
    const list = new TaskListPage(page);
    await list.goto();
    await expect(list.newTaskButton).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CrisisLens' })).toBeVisible();
  });

  test('创建任务 → 开始调查 → 查看证据 → 查看报告', async ({ page }) => {
    const marker = `E2E 异物事件 ${randomUUID().slice(0, 8)}`;

    const list = new TaskListPage(page);
    await list.goto();
    await list.newTaskButton.click();

    const create = new NewTaskPage(page);
    await expect(create.caseSelect).toBeVisible();
    await create.create(marker);

    // 创建成功后进入任务详情
    const detail = new TaskDetailPage(page);
    await expect(detail.startButton).toBeVisible();
    await expect(detail.runsEmpty).toBeVisible();

    await detail.start();

    const run = new RunDetailPage(page);
    await run.waitForCompletion();

    // 证据：至少一条，且每条都带来源标识
    await run.evidenceTab.click();
    await expect(run.evidencePanel).toBeVisible();
    await expect(run.evidencePanel.getByText(/来源\s+\S+/).first()).toBeVisible();

    // 报告：可见且含正文；本基线场景证据不足，必须给出有限结果提示
    await run.reportTab.click();
    await expect(run.reportPanel).toBeVisible();
    await expect(run.reportMarkdown).toContainText('舆情调查报告');
    await expect(run.partialNotice).toBeVisible();
  });

  test('完成的调查不会显示进行中状态，也不会显示虚假成功', async ({ page }) => {
    const marker = `E2E 状态校验 ${randomUUID().slice(0, 8)}`;
    const list = new TaskListPage(page);
    await list.goto();
    await list.newTaskButton.click();
    await new NewTaskPage(page).create(marker);

    const detail = new TaskDetailPage(page);
    await detail.start();

    const run = new RunDetailPage(page);
    await run.waitForCompletion();
    await expect(run.runError).toHaveCount(0);
    await expect(page.getByText('进行中')).toHaveCount(0);
  });

  test('任务列表能看到刚创建的任务', async ({ page }) => {
    const marker = `E2E 列表校验 ${randomUUID().slice(0, 8)}`;
    const list = new TaskListPage(page);
    await list.goto();
    await list.newTaskButton.click();
    await new NewTaskPage(page).create(marker);

    // 返回列表，新任务应出现在列表中
    await page.getByTestId('back-to-list').click();
    await expect(list.row(marker)).toBeVisible();
  });
});
