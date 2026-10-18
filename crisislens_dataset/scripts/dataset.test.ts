import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('manifest contains real cases only and no inline answers', () => {
  const rows = readFileSync(root + 'cases.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(row => row.case_id !== 'CASE_ID' && !('gold' in row)));
  assert.ok(rows.some(row => row.type === 'process'));
});
test('dataset validation and fixture runner exist', () => {
  assert.ok(existsSync(root + 'scripts/validate.ts'));
  assert.ok(existsSync(root + 'scripts/fixture-runner.ts'));
});
test('all fixtures, gold quotes, schemas and split membership validate', async () => {
  const { validateDataset } = await import('./validate.ts');
  assert.deepEqual(validateDataset(root).errors, []);
});
test('Agent projection contains neither Gold nor private paths', async () => {
  const { createFixtureRunner } = await import('./fixture-runner.ts');
  const runner = createFixtureRunner(root, 'food_foreign_object_001');
  const text = JSON.stringify(runner.input);
  for (const forbidden of ['gold_ref', 'expected_conclusion', 'necessary_evidence', 'content_ref', 'CANARY_CONTRACT']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.equal(runner.call('fetch_source', { id: '../../schemas/gold.schema.json' }).status, 'not_found');
  assert.equal(runner.call('read_internal_doc', { id: 'supplier_contract_001' }).status, 'permission_denied');
  assert.ok(!JSON.stringify(runner.trace).includes('CANARY_CONTRACT'));
});
test('persistent timeout stops retrying and is not empty success', async () => {
  const { createFixtureRunner } = await import('./fixture-runner.ts');
  const runner = createFixtureRunner(root, 'food_foreign_object_001_timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'retry_exhausted');
});
test('temporary timeout permits exactly the configured recovery', async () => {
  const { createFixtureRunner } = await import('./fixture-runner.ts');
  const runner = createFixtureRunner(root, 'process_permission_recovery_001');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'timeout');
  assert.equal(runner.call('read_internal_doc', { id: 'qc_report_001' }).status, 'ok');
});
test('empty retrieval, tool channel and overall call budget are distinct', async () => {
  const { createFixtureRunner } = await import('./fixture-runner.ts');
  const runner = createFixtureRunner(root, 'food_foreign_object_001');
  assert.deepEqual(runner.call('search_sources', { query: '不存在的来源' }), { status: 'ok', items: [] });
  assert.equal(runner.call('fetch_source', { id: 'qc_report_001' }).status, 'wrong_tool');
  for (let i = 2; i < 14; i++) runner.call('search_sources', { query: '投诉' });
  assert.equal(runner.call('fetch_source', { id: 'complaint_001' }).status, 'budget_exhausted');
});
test('validator rejects corrupted evidence and event-family split leakage', async () => {
  const { validateDataset } = await import('./validate.ts');
  const copy = mkdtempSync(join(tmpdir(), 'crisislens-validation-'));
  cpSync(root, copy, { recursive: true });
  const rows = readFileSync(join(copy, 'cases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const goldPath = join(copy, rows[0].gold_ref);
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  gold.expected_facts[0].evidence[0].quote = '故意损坏的、不存在于材料中的引文';
  writeFileSync(goldPath, JSON.stringify(gold));
  rows[1].split = 'holdout';
  writeFileSync(join(copy, 'cases.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const { errors } = validateDataset(copy);
  assert.ok(errors.some(e => e.includes('ungrounded quote')));
  assert.ok(errors.some(e => e.includes('family split leakage')));
  assert.ok(errors.some(e => e.includes('split membership mismatch')));
});
test('Schema rejects answer fields and nonpositive budgets', async () => {
  const { checkSchema } = await import('./validate.ts');
  const schema = JSON.parse(readFileSync(root + 'schemas/case.schema.json', 'utf8'));
  const entry = JSON.parse(readFileSync(root + 'cases.jsonl', 'utf8').split('\n')[0]);
  entry.gold = { expected_conclusion: 'leak' };
  entry.budget.max_tool_calls = 0;
  const errors = checkSchema(entry, schema);
  assert.ok(errors.some(e => e.includes('unknown gold')));
  assert.ok(errors.some(e => e.includes('below minimum')));
});
