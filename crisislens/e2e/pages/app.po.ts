// 页面对象。按 playwright-expert：优先 role-based 选择器，
// 动态生成的元素用约定的 data-testid（组件里已埋点）。
import type { Locator, Page } from '@playwright/test';

/** 转义正则元字符，避免任务文本里的 . ? ( ) 等被当作正则语法。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TaskListPage {
  readonly page: Page;
  readonly newTaskButton: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newTaskButton = page.getByRole('button', { name: '新建任务' });
    this.emptyState = page.getByRole('status');
  }

  async goto(): Promise<void> {
    await this.page.goto('/?demo=1');
  }

  /**
   * 定位任务行。用完整 userTask 文本做匹配：
   * 早期实现只取前 12 字符，历史任务时间戳前缀相同会导致 strict mode violation。
   */
  row(userTask: string): Locator {
    return this.page.getByRole('button', { name: new RegExp(escapeRegExp(userTask)) });
  }
}

export class NewTaskPage {
  readonly page: Page;
  readonly caseSelect: Locator;
  readonly userTaskInput: Locator;
  readonly submitButton: Locator;
  readonly errorBanner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.caseSelect = page.getByLabel('调查场景');
    this.userTaskInput = page.getByTestId('usertask-input');
    this.submitButton = page.getByRole('button', { name: '创建任务' });
    this.errorBanner = page.getByTestId('create-error');
  }

  async create(userTask: string): Promise<void> {
    await this.userTaskInput.fill(userTask);
    await this.submitButton.click();
  }
}

export class TaskDetailPage {
  readonly page: Page;
  readonly startButton: Locator;
  readonly runsEmpty: Locator;

  constructor(page: Page) {
    this.page = page;
    this.startButton = page.getByTestId('start-run');
    this.runsEmpty = page.getByTestId('runs-empty');
  }

  async start(): Promise<void> {
    await this.startButton.click();
  }
}

export class RunDetailPage {
  readonly page: Page;
  readonly evidenceTab: Locator;
  readonly reportTab: Locator;
  readonly evidencePanel: Locator;
  readonly reportPanel: Locator;
  readonly partialNotice: Locator;
  readonly reportMarkdown: Locator;
  readonly runError: Locator;
  readonly evidenceEmpty: Locator;

  constructor(page: Page) {
    this.page = page;
    this.evidenceTab = page.getByRole('tab', { name: '证据' });
    this.reportTab = page.getByRole('tab', { name: '报告' });
    this.evidencePanel = page.getByTestId('panel-evidence');
    this.reportPanel = page.getByTestId('panel-report');
    this.partialNotice = page.getByTestId('partial-notice');
    this.reportMarkdown = page.getByTestId('report-markdown');
    this.runError = page.getByTestId('run-error');
    this.evidenceEmpty = page.getByTestId('evidence-empty');
  }

  /** 等待运行结束：轮询后端状态而不是 sleep 固定时长。 */
  async waitForCompletion(): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="panel-events"]');
        if (el === null) return false;
        const badge = document.querySelector('.badge');
        return badge !== null && badge.textContent !== '进行中';
      },
      undefined,
      { timeout: 30_000 },
    );
  }
}
