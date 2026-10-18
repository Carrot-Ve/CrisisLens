import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// Evaluator-side only: do not expose the dataset filesystem to the tested Agent.
export function safeRead(root: string, ref: string): string {
  const base = realpathSync(root);
  if (isAbsolute(ref)) throw new Error('absolute fixture path rejected');
  const target = realpathSync(resolve(base, ref));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('fixture path escapes dataset root');
  return readFileSync(target, 'utf8');
}
export function manifest(root: string): any[] {
  return safeRead(root, 'cases.jsonl').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
export function createFixtureRunner(root: string, caseId: string) {
  const entry = manifest(root).find(c => c.case_id === caseId);
  if (!entry) throw new Error(`Unknown case: ${caseId}`);
  const raw = JSON.parse(safeRead(root, entry.input_ref));
  const input = {
    case_id: raw.case_id, user_task: raw.user_task, data_origin: raw.data_origin,
    ...(entry.type === 'process' ? { module: raw.module, module_input: raw.module_input } : {}),
    final_delivery: raw.final_delivery, budget: structuredClone(entry.budget),
    tools: ['search_sources', 'fetch_source', 'search_internal_docs', 'read_internal_doc'],
  };
  const trace: any[] = [];
  const attempts = new Map<string, number>();
  const failures = new Map<string, number>();
  let calls = 0;
  const metadata = (f: any) => ({ id: f.id, title: f.title, channel: f.channel, access: entry.permissions.deny.includes(f.id) ? 'denied' : 'allowed' });
  function call(tool: string, args: { id?: string; query?: string }): any {
    function done(result: any) { trace.push({ seq: trace.length + 1, tool, args: structuredClone(args), result: structuredClone(result) }); return result; }
    if (calls >= entry.budget.max_tool_calls) return done({ status: 'budget_exhausted' });
    calls++;
    if (!input.tools.includes(tool)) return done({ status: 'unknown_tool' });
    if (tool === 'search_sources' || tool === 'search_internal_docs') {
      if (typeof args.query !== 'string') return done({ status: 'invalid_args' });
      const channel = tool === 'search_sources' ? 'public' : 'internal';
      const query = args.query.trim().toLowerCase();
      return done({ status: 'ok', items: entry.fixtures.filter((f: any) => f.channel === channel && (f.title.toLowerCase().includes(query) || f.id.includes(query))).map(metadata) });
    }
    if (typeof args.id !== 'string') return done({ status: 'invalid_args' });
    const fixture = entry.fixtures.find((f: any) => f.id === args.id);
    if (!fixture) return done({ status: 'not_found' });
    // Deny overrides allow; no file read before authorization.
    if (entry.permissions.deny.includes(fixture.id) || !entry.permissions.allow.includes(fixture.id)) return done({ status: 'permission_denied', source_id: fixture.id });
    if ((tool === 'fetch_source' ? 'public' : 'internal') !== fixture.channel) return done({ status: 'wrong_tool' });
    const key = `${tool}:${fixture.id}`;
    if ((failures.get(key) ?? 0) > entry.budget.max_retries_per_resource) return done({ status: 'retry_exhausted', source_id: fixture.id });
    const index = attempts.get(key) ?? 0;
    attempts.set(key, index + 1);
    const fault = entry.fault_injections.find((f: any) => f.tool === tool && f.resource_id === fixture.id);
    const outcome = fault ? fault.outcomes[Math.min(index, fault.outcomes.length - 1)] : 'ok';
    if (outcome === 'timeout') {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      return done({ status: 'timeout', source_id: fixture.id, attempt: index + 1 });
    }
    failures.delete(key);
    return done({ status: 'ok', source_id: fixture.id, content: safeRead(root, fixture.content_ref) });
  }
  return { input, call, trace };
}
