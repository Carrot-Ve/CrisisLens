import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifest, safeRead, createFixtureRunner } from './fixture-runner.ts';

// Closed Schema subset for this repository; unsupported keywords fail explicitly.
export function checkSchema(value: any, schema: any, path = '$'): string[] {
  const errors: string[] = [];
  const supported = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minimum', 'minLength', 'pattern', 'enum', 'const']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) errors.push(`${path}: unsupported schema keyword ${key}`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = (t: string) => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : typeof value === t;
  if (types.length && !types.some(matches)) return [...errors, `${path}: expected ${types.join('|')}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum`);
  if ('const' in schema && value !== schema.const) errors.push(`${path}: invalid const`);
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0)) errors.push(`${path}: string too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
  }
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) errors.push(`${path}: below minimum`);
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) errors.push(`${path}: too few items`);
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.items) value.forEach((v, i) => errors.push(...checkSchema(v, schema.items, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...checkSchema(item, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown ${key}`);
    }
  }
  return errors;
}
export function validateDataset(root: string) {
  const errors: string[] = [];
  const rows = manifest(root);
  const caseSchema = JSON.parse(safeRead(root, 'schemas/case.schema.json'));
  const goldSchema = JSON.parse(safeRead(root, 'schemas/gold.schema.json'));
  const familySplits = new Map<string, string>();
  const ids = rows.map(c => c.case_id);
  if (new Set(ids).size !== ids.length) errors.push('duplicate case_id');
  for (const c of rows) {
    try {
      const caseErrors = checkSchema(c, caseSchema, c.case_id); errors.push(...caseErrors);
      if (caseErrors.length) continue;
      if (familySplits.has(c.family_id) && familySplits.get(c.family_id) !== c.split) errors.push(`${c.case_id}: family split leakage`);
      familySplits.set(c.family_id, c.split);
      if (c.variant_of) {
        const parent = rows.find(p => p.case_id === c.variant_of);
        if (!parent || parent.family_id !== c.family_id || parent.case_id === c.case_id) errors.push(`${c.case_id}: invalid variant parent`);
      }
      const input = JSON.parse(safeRead(root, c.input_ref));
      if (input.case_id !== c.case_id || !input.user_task || input.data_origin !== 'synthetic') errors.push(`${c.case_id}: invalid input identity/task/origin`);
      if (c.type === 'process' && (!input.module || !input.module_input)) errors.push(`${c.case_id}: missing process contract`);
      const scan = (value: any) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (['gold', 'gold_ref', 'expected_facts', 'assertions', 'necessary_evidence', 'expected_conclusion', 'content_ref', 'permissions', 'fault_injections'].includes(key)) errors.push(`${c.case_id}: evaluator key in Agent input: ${key}`);
          scan(item);
        }
      };
      scan(input);
      const fixtureIds = c.fixtures.map((f: any) => f.id);
      if (new Set(fixtureIds).size !== fixtureIds.length) errors.push(`${c.case_id}: duplicate fixture id`);
      for (const id of [...c.permissions.allow, ...c.permissions.deny]) if (!fixtureIds.includes(id)) errors.push(`${c.case_id}: unknown permission id ${id}`);
      if (c.permissions.allow.some((id: string) => c.permissions.deny.includes(id))) errors.push(`${c.case_id}: contradictory permissions`);
      const texts = new Map<string, string>();
      for (const f of c.fixtures) {
        const text = safeRead(root, f.content_ref); texts.set(f.id, text);
        if (!text.includes(`source_id: ${f.id}`) || text.includes('待人工核验并填充')) errors.push(`${c.case_id}: missing material content ${f.id}`);
      }
      for (const fault of c.fault_injections) {
        const target = c.fixtures.find((f: any) => f.id === fault.resource_id);
        if (!target || !c.permissions.allow.includes(target.id) || (fault.tool === 'fetch_source' ? 'public' : 'internal') !== target.channel) errors.push(`${c.case_id}: invalid fault target`);
      }
      const gold = JSON.parse(safeRead(root, c.gold_ref));
      const goldErrors = checkSchema(gold, goldSchema, `${c.case_id}.gold`); errors.push(...goldErrors);
      if (goldErrors.length) continue;
      if (gold.case_id !== c.case_id) errors.push(`${c.case_id}: mismatched Gold id`);
      safeRead(root, gold.scoring_ref);
      for (const fact of gold.expected_facts) for (const ev of fact.evidence) {
        if (!c.permissions.allow.includes(ev.source_id) || !texts.get(ev.source_id)?.includes(ev.quote)) errors.push(`${c.case_id}: ungrounded quote ${fact.id}/${ev.source_id}`);
      }
      if (JSON.stringify(createFixtureRunner(root, c.case_id).input).includes('CANARY_CONTRACT')) errors.push(`${c.case_id}: secret leaked to input`);
    } catch (error) { errors.push(`${c.case_id}: ${String(error)}`); }
  }
  for (const split of ['dev', 'regression', 'holdout']) {
    const actual = safeRead(root, `splits/${split}.jsonl`).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).case_id).sort();
    const expected = rows.filter(c => c.split === split).map(c => c.case_id).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${split}: split membership mismatch`);
  }
  return { cases: rows.length, end_to_end: rows.filter(c => c.type === 'end_to_end').length, process: rows.filter(c => c.type === 'process').length, families: familySplits.size, errors, note: 'Static structure/reference checks only; not an Agent evaluation or human Gold approval.' };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = validateDataset(fileURLToPath(new URL('../', import.meta.url)));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) { console.error(error); process.exitCode = 1; }
}
