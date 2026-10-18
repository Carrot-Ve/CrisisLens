// 启动后端服务：HTTP API + 可选前端静态资源。
// 用法：npm run serve -- --port 8787
//       --db     SQLite 文件路径（默认 data/crisislens.db）
//       --web    前端构建产物目录（默认 web/dist，不存在时只提供 API）
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInvestigationService } from '../src/app/service.ts';
import { openDb } from '../src/storage/db.ts';
import { listen } from '../src/server/http.ts';
import { createLiveService } from '../src/live/service.ts';
import { initializeTracing, shutdownTracing } from '../src/live/tracing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
if(existsSync(resolve(packageRoot,'.env')))process.loadEnvFile(resolve(packageRoot,'.env'));
const tracingEnv=resolve(packageRoot,'.env.langfuse');
if(existsSync(tracingEnv))process.loadEnvFile(tracingEnv);
try {initializeTracing();} catch {console.warn('Langfuse initialization failed; investigation remains available');}
const datasetRoot = resolve(packageRoot, '..', 'crisislens_dataset');

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const port = Number(flag(argv, '--port') ?? process.env.PORT ?? '8787');
const dbPath = flag(argv, '--db') ?? resolve(packageRoot, 'data', 'crisislens.db');
const webRoot = flag(argv, '--web') ?? resolve(packageRoot, 'web', 'dist');

mkdirSync(dirname(dbPath), { recursive: true });
const handle = openDb(dbPath);
const service = createInvestigationService(handle.raw, datasetRoot);
const live = createLiveService(handle.raw);

const { server, port: actualPort } = await listen(service, {
  live,
  port,
  host: '127.0.0.1',
  webRoot: existsSync(webRoot) ? webRoot : null,
  tasksRoot: resolve(packageRoot, 'tasks'),
  datasetRoot: existsSync(datasetRoot) ? datasetRoot : null,
});

process.stdout.write(`CrisisLens API 已启动: http://127.0.0.1:${actualPort}\n`);
process.stdout.write(`数据库: ${dbPath}\n`);
process.stdout.write(`前端静态目录: ${existsSync(webRoot) ? webRoot : '（未构建，仅 API）'}\n`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    server.closeAllConnections();
    service.close();
    await live.close();
    await shutdownTracing();
    handle.close();
    process.exit(0);
  });
}
