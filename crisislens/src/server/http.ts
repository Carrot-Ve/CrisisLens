// 后端 HTTP API。选型：Node 原生 node:http，不引入 Express/Fastify。
// 理由：端点只有 8 个，路由与 JSON 序列化自己写不到 200 行，
// 引入 Web 框架对本阶段是纯负担（依赖、安全面、升级成本），且会模糊「零运行时依赖」的既有约定。
//
// 真实性约束：所有错误以 4xx/5xx + { error } 返回，运行失败时 status='failed'
// 并带 errorMessage。没有任何端点会返回硬编码的成功占位。
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { InvestigationService } from '../app/service.ts';
import type { RunStatus } from '../storage/repos.ts';
import type { LiveService } from '../live/service.ts';
import { liveRoute } from '../live/routes.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  service: InvestigationService;
  url: URL;
  webRoot: string | null;
  /** 任务规格目录（tasks/*.json），提供「澄清调查范围」的示例问题措辞。 */
  tasksRoot: string | null;
  /** 数据集根目录，提供可运行的调查场景（事件族 + 挑战变体）。 */
  datasetRoot: string | null;
}

export interface CaseOption {
  caseId: string;
  userTask: string;
  entities: string[];
  questions: unknown[];
  /** baseline = 基础事件族；challenge = 人为构造的压力变体（不是实际运行发现的 Bad Case）。 */
  kind: 'baseline' | 'challenge';
  /** 展示用短名，便于界面区分同族的不同变体。 */
  label: string;
  /** 挑战类型键，取自 variants_catalog.md；仅 challenge 有。 */
  challengeType?: string;
}

/** 挑战类型键 → 中文说明。键名来自 variants_catalog.md，此处仅补展示文案。 */
const CHALLENGE_LABELS: Record<string, string> = {
  missing_evidence: '材料缺失',
  temporal_scope: '时间口径变化',
  source_deduplication: '同源转载',
  persistent_tool_timeout: '持续超时',
  permission_boundary: '权限拒绝',
  source_prompt_injection: '来源提示注入',
  same_scope_contradiction: '真实证据冲突',
};

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 变体目录名 → 挑战类型键。对应关系从 variants_catalog.md 解析，不硬编码。 */
async function parseVariantsCatalog(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const text = await readFile(path, 'utf8');
    const re = /^-\s+([a-z_]+):\s*challenge_cases\/[^/]+\/([^/]+)\/input\.json/gm;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      map.set(m[2] as string, m[1] as string);
    }
  } catch {
    // 目录未写 catalog 时退化为用目录名
  }
  return map;
}

/** 事件族名称 → 该族的示例问题措辞（判据），来自 tasks/*.json。 */
async function readTaskSpecs(tasksRoot: string | null): Promise<
  Map<string, { entities: string[]; questions: unknown[] }>
> {
  const specs = new Map<string, { entities: string[]; questions: unknown[] }>();
  if (tasksRoot === null) return specs;
  try {
    for (const file of (await readdir(tasksRoot)).filter((f) => f.endsWith('.json'))) {
      const spec = await readJsonIfExists(join(tasksRoot, file));
      if (spec === null || typeof spec.caseId !== 'string') continue;
      specs.set(spec.caseId, {
        entities: Array.isArray(spec.entities) ? spec.entities.filter((e): e is string => typeof e === 'string') : [],
        questions: Array.isArray(spec.questions) ? spec.questions : [],
      });
    }
  } catch {
    // 目录不可读时返回空 Map，场景列表仍可用（只是没有默认问题）
  }
  return specs;
}

/**
 * 列出可运行的调查场景：每个事件族一个 baseline，加上它的每个挑战变体。
 * caseId 与 userTask 取自数据集自身的 input.json；questions 是「澄清调查范围」的
 * 示例判据措辞，不是评测 Gold —— 被测 Agent 只拿到措辞，拿不到预期结论。
 */
async function listCases(datasetRoot: string | null, tasksRoot: string | null): Promise<CaseOption[]> {
  if (datasetRoot === null) return [];
  const specs = await readTaskSpecs(tasksRoot);
  const out: CaseOption[] = [];

  const goldenRoot = join(datasetRoot, 'golden_cases');
  try {
    for (const entry of await readdir(goldenRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const input = await readJsonIfExists(join(goldenRoot, entry.name, 'input.json'));
      if (input === null || typeof input.case_id !== 'string') continue;
      const spec = specs.get(entry.name);
      out.push({
        caseId: input.case_id,
        userTask: typeof input.user_task === 'string' ? input.user_task : '',
        entities: spec?.entities ?? [],
        questions: spec?.questions ?? [],
        kind: 'baseline',
        label: '基础事件族',
      });
    }
  } catch {
    // golden_cases 不存在时跳过
  }

  const challengeRoot = join(datasetRoot, 'challenge_cases');
  try {
    for (const family of await readdir(challengeRoot, { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      const typeByDir = await parseVariantsCatalog(join(challengeRoot, family.name, 'variants_catalog.md'));
      const spec = specs.get(family.name);
      for (const variant of await readdir(join(challengeRoot, family.name), { withFileTypes: true })) {
        if (!variant.isDirectory()) continue;
        const input = await readJsonIfExists(join(challengeRoot, family.name, variant.name, 'input.json'));
        if (input === null || typeof input.case_id !== 'string') continue;
        const type = typeByDir.get(variant.name);
        const label =
          type === undefined ? variant.name : `${CHALLENGE_LABELS[type] ?? type}（${variant.name}）`;
        out.push({
          caseId: input.case_id,
          userTask: typeof input.user_task === 'string' ? input.user_task : '',
          entities: spec?.entities ?? [],
          questions: spec?.questions ?? [],
          kind: 'challenge',
          label,
          ...(type === undefined ? {} : { challengeType: type }),
        });
      }
    }
  } catch {
    // challenge_cases 不存在时跳过
  }

  // 基线排在前，其余按 caseId 稳定排序
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'baseline' ? -1 : 1;
    return a.caseId.localeCompare(b.caseId);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    // 开发环境前端跑在 Vite(5173)，与 API(默认 8787) 不同源，需要 CORS。
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * 事件流（SSE）。
 * 实现：按 afterSequence 增量轮询 DB 并推送，运行结束后关闭连接。
 * 为什么是轮询而不是内存事件总线：事件已经落库且带单调 sequence，
 * 轮询让「断线重连续传」和「已完成运行的完整回放」用同一套逻辑，不需要额外状态。
 */
async function streamEvents(ctx: RouteContext, runId: string, after: number): Promise<void> {
  const { res, service } = ctx;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  let cursor = after;
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const tick = async (): Promise<void> => {
    if (closed) return;
    let runExists = true;
    try {
      const run = service.getRun(runId);
      if (run === null) {
        runExists = false;
      } else {
        const events = service.getEventStream(runId, cursor);
        for (const e of events) {
          res.write(`id: ${e.sequence}\nevent: ${e.type}\ndata: ${e.payload}\n\n`);
          cursor = e.sequence;
        }
        if (run.status !== 'running') {
          // 运行已结束：补一次收尾推送再关闭，避免客户端漏掉最后一批。
          const tail = service.getEventStream(runId, cursor);
          for (const e of tail) {
            res.write(`id: ${e.sequence}\nevent: ${e.type}\ndata: ${e.payload}\n\n`);
            cursor = e.sequence;
          }
          res.write(`event: done\ndata: ${JSON.stringify({ status: run.status, stopReason: run.stopReason })}\n\n`);
          res.end();
          return;
        }
      }
    } catch {
      runExists = false;
    }
    if (!runExists) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: '运行不存在' })}\n\n`);
      res.end();
      return;
    }
    setTimeout(() => void tick(), 120);
  };

  await tick();
}

/** 静态文件服务。防目录穿越：规范化后必须仍在 webRoot 之内。 */
async function serveStatic(ctx: RouteContext, pathname: string): Promise<void> {
  const { res, webRoot } = ctx;
  if (webRoot === null) {
    sendError(res, 404, '未配置前端静态目录');
    return;
  }
  const root = resolve(webRoot);
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(root, normalize(rel));
  if (target !== root && !target.startsWith(root + sep)) {
    sendError(res, 403, '禁止的路径');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      const indexFile = join(target, 'index.html');
      const body = await readFile(indexFile);
      res.writeHead(200, { 'content-type': MIME['.html'] ?? 'text/html' });
      res.end(body);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    // SPA 回退：未知路径交给前端路由
    try {
      const body = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] ?? 'text/html' });
      res.end(body);
    } catch {
      sendError(res, 404, '前端资源未构建');
    }
  }
}

async function route(ctx: RouteContext, method: string, pathname: string): Promise<void> {
  const { res, service } = ctx;
  const segments = pathname.split('/').filter((s) => s.length > 0);

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  // /api/cases
  if (segments[0] === 'api' && segments[1] === 'cases' && segments.length === 2 && method === 'GET') {
    sendJson(res, 200, { cases: await listCases(ctx.datasetRoot, ctx.tasksRoot) });
    return;
  }

  // /api/tasks
  if (segments[0] === 'api' && segments[1] === 'tasks') {
    if (method === 'GET' && segments.length === 2) {
      sendJson(res, 200, { tasks: service.listTasks(100) });
      return;
    }
    if (method === 'POST' && segments.length === 2) {
      const body = (await readBody(ctx.req)) as Record<string, unknown> | null;
      if (body === null) {
        sendError(res, 400, '请求体不是合法 JSON');
        return;
      }
      const { caseId, userTask, entities, questions } = body;
      if (typeof caseId !== 'string' || caseId.length === 0) {
        sendError(res, 400, '缺少 caseId');
        return;
      }
      if (typeof userTask !== 'string' || userTask.length === 0) {
        sendError(res, 400, '缺少 userTask');
        return;
      }

      // 逐个字段校验，不把未经验证的输入直接透传给领域层。
      const rawQuestions = Array.isArray(questions) ? questions : [];
      const parsedQuestions = rawQuestions
        .filter((q): q is { id: string; text: string; positiveTerms?: unknown; negativeTerms?: unknown } => {
          if (typeof q !== 'object' || q === null) return false;
          const rec = q as Record<string, unknown>;
          return typeof rec.id === 'string' && typeof rec.text === 'string';
        })
        .map((q) => ({
          id: q.id,
          text: q.text,
          // 新建任务的问题一律未解决；不接受客户端自称已解决。
          status: 'open' as const,
          ...(Array.isArray(q.positiveTerms) ? { positiveTerms: q.positiveTerms.filter((t): t is string => typeof t === 'string') } : {}),
          ...(Array.isArray(q.negativeTerms) ? { negativeTerms: q.negativeTerms.filter((t): t is string => typeof t === 'string') } : {}),
        }));

      if (parsedQuestions.length === 0) {
        sendError(res, 400, '至少需要一个合法调查问题（需含 id 与 text）');
        return;
      }

      const task = service.createTask({
        caseId,
        userTask,
        entities: Array.isArray(entities) ? entities.filter((e): e is string => typeof e === 'string') : [],
        questions: parsedQuestions,
      });
      sendJson(res, 201, { task });
      return;
    }
    // /api/tasks/:taskId
    if (segments.length === 3 && method === 'GET') {
      const taskId = segments[2] ?? '';
      const task = service.getTask(taskId);
      if (task === null) {
        sendError(res, 404, '任务不存在');
        return;
      }
      sendJson(res, 200, { task, runs: service.listRuns(taskId) });
      return;
    }
    // /api/tasks/:taskId/runs
    if (segments.length === 4 && segments[3] === 'runs' && method === 'POST') {
      const taskId = segments[2] ?? '';
      try {
        const runId = await service.startRun(taskId);
        sendJson(res, 202, { runId });
      } catch (error) {
        sendError(res, 404, error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }

  // /api/runs/:runId[/...]
  if (segments[0] === 'api' && segments[1] === 'runs' && segments.length >= 3) {
    const runId = segments[2] ?? '';
    const sub = segments[3];

    if (method === 'GET' && sub === undefined) {
      const run = service.getRun(runId);
      if (run === null) {
        sendError(res, 404, '运行不存在');
        return;
      }
      sendJson(res, 200, { run });
      return;
    }
    if (method === 'GET' && sub === 'detail') {
      try {
        const after = Number(ctx.url.searchParams.get('after') ?? '-1');
        sendJson(res, 200, service.getRunDetail(runId, Number.isFinite(after) ? after : -1));
      } catch (error) {
        sendError(res, 404, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (method === 'GET' && sub === 'events') {
      const after = Number(ctx.url.searchParams.get('after') ?? '-1');
      sendJson(res, 200, { events: service.getEventStream(runId, Number.isFinite(after) ? after : -1) });
      return;
    }
    if (method === 'GET' && sub === 'stream') {
      const after = Number(ctx.url.searchParams.get('after') ?? '-1');
      await streamEvents(ctx, runId, Number.isFinite(after) ? after : -1);
      return;
    }
    if (method === 'GET' && sub === 'evidence') {
      try {
        const detail = service.getRunDetail(runId);
        sendJson(res, 200, { evidence: detail.evidence, claims: detail.claims, conflicts: detail.conflicts });
      } catch (error) {
        sendError(res, 404, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (method === 'GET' && sub === 'report') {
      try {
        const detail = service.getRunDetail(runId);
        sendJson(res, 200, { report: detail.report });
      } catch (error) {
        sendError(res, 404, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (method === 'POST' && sub === 'cancel') {
      const ok = service.cancelRun(runId);
      // 已结束的运行返回 409 而不是假装取消成功。
      if (!ok) {
        sendError(res, 409, '运行不在进行中，无法取消');
        return;
      }
      sendJson(res, 200, { cancelled: true });
      return;
    }
  }

  // 非 API 路径交给前端
  if (pathname.startsWith('/api/')) {
    sendError(res, 404, '未知接口');
    return;
  }
  await serveStatic(ctx, pathname);
}

export interface HttpServerOptions {
  live?: LiveService;
  port: number;
  host?: string;
  /** 前端构建产物目录；为 null 时只提供 API。 */
  webRoot?: string | null;
  /** 任务规格目录；为 null 时 /api/cases 不提供默认调查问题。 */
  tasksRoot?: string | null;
  /** 数据集根目录；为 null 时 /api/cases 返回空列表。 */
  datasetRoot?: string | null;
}

export function createApiServer(
  service: InvestigationService,
  options: HttpServerOptions,
): Server {
  const webRoot = options.webRoot ?? null;
  const tasksRoot = options.tasksRoot ?? null;
  const datasetRoot = options.datasetRoot ?? null;
  const server = createHttpServer((req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) {
      sendError(res, 403, '仅允许本机访问'); return;
    }
    const origin = req.headers.origin;
    if (origin && ![`http://${host}`, 'http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
      sendError(res, 403, '禁止跨站访问'); return;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      sendError(res, 403, '禁止跨站访问'); return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/live/')) {
      if (!options.live) { sendError(res, 503, '真实调查服务未启用'); return; }
      void liveRoute(req, res, url, options.live).catch((error: unknown) => {
        if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error));
        else res.end();
      });
      return;
    }
    const ctx: RouteContext = {
      req,
      res,
      service,
      url,
      webRoot,
      tasksRoot,
      datasetRoot,
    };
    route(ctx, req.method ?? 'GET', url.pathname).catch((error: unknown) => {
      sendError(res, 500, error instanceof Error ? error.message : String(error));
    });
  });
  return server;
}

export function listen(
  service: InvestigationService,
  options: HttpServerOptions,
): Promise<{ server: Server; port: number }> {
  const server = createApiServer(service, options);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolvePromise({ server, port });
    });
  });
}

export type { RunStatus };
