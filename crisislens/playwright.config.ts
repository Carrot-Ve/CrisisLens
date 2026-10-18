import { defineConfig } from '@playwright/test';

const PORT = 8788;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // 所有用例共享同一个后端服务与 SQLite，串行执行以避免相互干扰。
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  globalSetup: './e2e/setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // 允许用环境变量指定已安装的 Chromium（本机缓存里可能已有可用版本）。
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
});
