// 端到端运行一次调查任务，并把可追溯产物写到 runs/<runId>/。
// 用法：npm run investigate -- --case food_foreign_object_001
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeModel } from '../src/adapters/model/fake-model.ts';
import { createFixtureRunner, toToolPort } from '../src/adapters/tools/deterministic-tools.ts';
import { DEFAULT_BUDGET } from '../src/core/state.ts';
import type { InvestigationTask, Question } from '../src/core/types.ts';
import { runInvestigation } from '../src/runtime/runtime.ts';
import type { RunSnapshot } from '../src/runtime/runtime.ts';
import { createRunWriter, writeRunArtifacts } from '../src/storage/run-writer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const datasetRoot = process.env.CRISISLENS_DATASET_ROOT ?? resolve(packageRoot, '..', 'crisislens_dataset');

interface TaskSpec {
  caseId: string;
  userTask: string;
  entities: string[];
  questions: (Question & { positiveTerms?: string[]; negativeTerms?: string[] })[];
}

function parseArgs(argv: string[]): { caseId: string; taskPath?: string; runsRoot: string } {
  const caseId = flag(argv, '--case') ?? 'food_foreign_object_001';
  const taskPath = flag(argv, '--task');
  const runsRoot = flag(argv, '--runs') ?? resolve(packageRoot, 'runs');
  return { caseId, taskPath, runsRoot };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const { caseId, taskPath, runsRoot } = parseArgs(process.argv.slice(2));
  const specPath = taskPath ?? resolve(packageRoot, 'tasks', `${caseId}.json`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as TaskSpec;

  const runner = createFixtureRunner(datasetRoot, caseId);
  const task: InvestigationTask = {
    taskId: `task_${caseId}`,
    caseId,
    userTask: spec.userTask,
    entities: spec.entities,
    questions: spec.questions.map((q) => ({
      ...q,
      id: q.id,
      text: q.text,
      status: 'open' as const,
    })),
    budget: {
      ...DEFAULT_BUDGET,
      maxToolCalls: runner.manifest.budget.max_tool_calls,
      maxTokens: runner.manifest.budget.max_tokens,
      maxRetriesPerResource: runner.manifest.budget.max_retries_per_resource,
    },
  };

  const runId = `run_${caseId}_${Date.now().toString(36)}`;
  const artifacts = createRunWriter(runsRoot, runId);
  let snapshot: RunSnapshot = {
    runId,
    caseId,
    state: {},
    evidence: [],
    claims: [],
    conflicts: [],
  };

  const outcome = await runInvestigation(
    task,
    {
      model: createFakeModel(),
      tools: toToolPort(runner),
      sink: artifacts.sink,
      checkpoint: (snap) => {
        snapshot = snap;
      },
    },
    { runId },
  );

  writeRunArtifacts(artifacts, snapshot, outcome.report, outcome.events);

  const summary = {
    runId,
    caseId,
    reportStatus: outcome.report.status,
    stopReason: outcome.stopReason,
    toolCalls: runner.trace.length,
    evidenceCount: (snapshot.evidence as unknown[]).length,
    conflicts: (snapshot.conflicts as unknown[]).length,
    missingMaterial: outcome.report.missingMaterial,
    artifacts: {
      trace: artifacts.tracePath,
      report: artifacts.reportPath,
      state: artifacts.statePath,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
