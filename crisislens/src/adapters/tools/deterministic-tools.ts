// 阶段 1 的确定性工具适配器。
//
// 重要：夹具语义的唯一真相来源是评测侧的 crisislens_dataset/scripts/fixture-runner.ts，
// 本文件只做「夹具状态码 → Core 领域 ToolResult」的映射，不另造一套工具语义。
// 否则评测跑的和产品跑的是两套东西，评测结果不能代表被测产品行为。
// 接真实检索后，这里替换为真实 Adapter，ToolPort 契约不变。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRunner as createDatasetFixtureRunner } from '../../../../crisislens_dataset/scripts/fixture-runner.ts';
import type { ToolErrorCode, ToolFailureCode, ToolName, ToolResult } from '../../core/types.ts';
import type { ToolPort } from '../../core/ports.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** 数据集根目录：src/adapters/tools → adapters → src → crisislens → 项目根 */
export const DATASET_ROOT = resolve(here, '..', '..', '..', '..', 'crisislens_dataset');

export interface FixtureItem {
  id: string;
  title: string;
  channel: 'public' | 'internal';
  content_ref: string;
}

export interface CaseManifest {
  schema_version: string;
  case_id: string;
  family_id: string;
  split: string;
  type: string;
  input_ref: string;
  gold_ref: string;
  fixtures: FixtureItem[];
  permissions: { allow: string[]; deny: string[] };
  budget: { max_tool_calls: number; max_tokens: number; max_retries_per_resource: number };
  fault_injections: { tool: string; resource_id: string; outcomes: string[] }[];
}

export interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  status: ToolErrorCode | 'empty';
}

export interface FixtureRunner {
  readonly caseId: string;
  readonly manifest: CaseManifest;
  /** 交给被测 Agent 的输入投影，不含 Gold。 */
  readonly input: Record<string, unknown>;
  call(tool: string, args: Record<string, unknown>): RawToolResult;
  readonly trace: TraceEntry[];
}

export interface RawCandidate {
  id?: string;
  title: string;
  channel?: string;
  access?: string;
}

export type RawToolResult =
  | { status: 'ok'; items: RawCandidate[] }
  | { status: 'ok'; source_id?: string; content?: string }
  | { status: string };

export function loadManifest(root: string, caseId: string): CaseManifest {
  const raw = readFileSync(resolve(root, 'cases.jsonl'), 'utf8');
  const rows = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CaseManifest);
  const found = rows.find((r) => r.case_id === caseId);
  if (!found) throw new Error(`case not found: ${caseId}`);
  return found;
}

/** 夹具状态码 → Core 领域错误码。未知工具与参数错误统一归为 invalid_argument。 */
function mapFailure(code: string): ToolFailureCode {
  switch (code) {
    case 'unknown_tool':
    case 'invalid_args':
      return 'invalid_argument';
    case 'not_found':
      return 'not_found';
    case 'permission_denied':
      return 'permission_denied';
    case 'wrong_tool':
      return 'wrong_tool';
    case 'timeout':
      return 'timeout';
    case 'retry_exhausted':
      return 'retry_exhausted';
    case 'budget_exhausted':
      return 'budget_exhausted';
    default:
      return 'source_unavailable';
  }
}

interface InnerRunner {
  input: Record<string, unknown>;
  call: (tool: string, args: Record<string, unknown>) => RawToolResult;
  trace: { tool: string; args: Record<string, unknown>; result: RawToolResult }[];
}

export function createFixtureRunner(root: string, caseId: string): FixtureRunner {
  const manifest = loadManifest(root, caseId);
  const inner = createDatasetFixtureRunner(root, caseId) as unknown as InnerRunner;
  const trace: TraceEntry[] = [];

  return {
    caseId,
    manifest,
    input: inner.input,
    trace,
    call(tool: string, args: Record<string, unknown>): RawToolResult {
      const raw = inner.call(tool, args);
      const status = String((raw as { status: string }).status);
      if (status === 'ok' && 'items' in raw && Array.isArray(raw.items)) {
        trace.push({ tool, args, status: raw.items.length === 0 ? 'empty' : 'ok' });
      } else {
        trace.push({ tool, args, status: mapFailure(status) });
      }
      return raw;
    },
  };
}

export function toToolPort(runner: FixtureRunner): ToolPort {
  return {
    name: 'deterministic-fixture',
    async execute(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
      if (signal.aborted) {
        return {
          status: 'timeout',
          tool: 'search_sources',
          error: { code: 'timeout', message: 'aborted', retryable: false },
        };
      }
      const raw = runner.call(tool, args);
      const name = tool as ToolName;
      const status = String((raw as { status: string }).status);

      if (status === 'ok' && 'items' in raw && Array.isArray(raw.items)) {
        if (raw.items.length === 0) return { status: 'empty', tool: name, candidates: [] };
        return {
          status: 'ok',
          tool: name,
          candidates: raw.items.map((i) => ({
            sourceId: String(i.id ?? ''),
            title: i.title,
            channel: (i.channel ?? 'public') as 'public' | 'internal',
            // 受限材料只暴露目录元数据，绝不返回正文片段。
            snippet: i.access === 'denied' ? '受限材料，仅目录元数据' : `${i.title}（${i.channel === 'public' ? '公开' : '内部'}）`,
          })),
        };
      }

      if (status === 'ok' && 'content' in raw) {
        const sourceId = String((raw as { source_id?: string }).source_id ?? (args.id as string) ?? '');
        const item = runner.manifest.fixtures.find((f) => f.id === sourceId);
        return {
          status: 'ok',
          tool: name,
          source: {
            sourceId,
            title: item?.title ?? sourceId,
            channel: (item?.channel ?? 'public') as 'public' | 'internal',
            content: String((raw as { content?: string }).content ?? ''),
          },
        };
      }

      const code = mapFailure(status);
      return {
        status: code,
        tool: name,
        error: {
          code,
          message: `夹具返回 ${status}`,
          retryable: code === 'timeout' || code === 'source_unavailable',
        },
      } as ToolResult;
    },
  };
}
