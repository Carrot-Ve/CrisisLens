// Runtime / Harness：一次 run 怎么真的发生并活下来。
// 这里拥有预算、超时、有限重试、取消、事件记录、检查点；Core 从不检查预算。
import { buildModelContext } from '../core/context.ts';
import { createEvidenceStore, quoteIsVerifiable } from '../core/evidence.ts';
import type { Claim, InvestigationState, InvestigationTask, SourceCandidate, ToolName } from '../core/types.ts';
import type { ModelPort, ToolPort } from '../core/ports.ts';
import { createInitialState, recordFailure, syncQuestionsFromClaims } from '../core/state.ts';
import { evaluateStop } from '../core/stop.ts';
import type { StopReason } from '../core/stop.ts';
import { generateReport } from '../core/report.ts';
import type { Report } from '../core/report.ts';
import type { AgentEvent } from './events.ts';
import { createEventLog } from './event-log.ts';
import type { EventLog, EventSink } from './event-log.ts';

export const TOOL_ALLOWLIST: ToolName[] = [
  'search_sources',
  'fetch_source',
  'search_internal_docs',
  'read_internal_doc',
];

const RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'rate_limited']);

export interface RuntimeDeps {
  model: ModelPort;
  tools: ToolPort;
  sink?: EventSink;
  /** 每轮结束后写出检查点。阶段 1 只写运行产物，不实现崩溃恢复。 */
  checkpoint?: (snapshot: RunSnapshot) => void | Promise<void>;
}

export interface RunSnapshot {
  runId: string;
  caseId: string;
  state: unknown;
  evidence: unknown[];
  claims: unknown[];
  conflicts: unknown[];
}

export interface RunOutcome {
  runId: string;
  events: AgentEvent[];
  report: Report;
  stopReason: StopReason | null;
}

function isToolName(value: string): value is ToolName {
  return (TOOL_ALLOWLIST as string[]).includes(value);
}

export async function runInvestigation(
  task: InvestigationTask,
  deps: RuntimeDeps,
  options: { signal?: AbortSignal; runId?: string } = {},
): Promise<RunOutcome> {
  const runId = options.runId ?? `run_${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const log: EventLog = createEventLog(runId, deps.sink);
  const store = createEvidenceStore();
  const state = createInitialState(task);

  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(task.budget.timeoutMs),
  ]);

  for (const q of task.questions) {
    const claim: Claim = {
      claimId: q.id,
      statement: q.text,
      links: [],
      status: 'unsupported',
      positiveTerms: q.positiveTerms ?? [],
      negativeTerms: q.negativeTerms ?? [],
    };
    store.registerClaim(claim);
  }

  const knownCandidates: SourceCandidate[] = [];
  let stopReason: StopReason | null = null;
  let stopDetails: string[] = [];

  log.append({ type: 'run_started', runId, caseId: task.caseId });
  log.append({
    type: 'state_initialized',
    runId,
    objective: state.objective,
    questionIds: state.questions.map((q) => q.id),
  });

  const unreadCandidates = () =>
    knownCandidates.filter((c) => !state.readSourceIds.includes(c.sourceId)).length;

  while (true) {
    if (signal.aborted) {
      log.append({ type: 'run_cancelled', runId });
      return finish(log, runId, task, state, store, 'cancelled', [], startedAt);
    }

    const decision0 = evaluateStop({
      state,
      claimStatuses: store.listClaims().map((c) => ({ claimId: c.claimId, status: c.status })),
      unreadCandidateCount: unreadCandidates(),
    });
    if (decision0.shouldStop) {
      log.append({
        type: 'stop_evaluated',
        runId,
        shouldStop: true,
        reason: decision0.reason,
        details: decision0.details,
      });
      stopReason = decision0.reason;
      stopDetails = decision0.details;
      break;
    }

    state.iterations += 1;
    const context = buildModelContext({
      state,
      evidence: store.list().map((e) => ({ evidenceId: e.evidenceId, sourceId: e.sourceId, quote: e.quote })),
      candidates: knownCandidates.map((c) => ({
        sourceId: c.sourceId,
        title: c.title,
        channel: c.channel,
        snippet: c.snippet,
      })),
    });
    log.append({
      type: 'context_built',
      runId,
      chars: Array.from(JSON.stringify(context)).length,
      evidenceCount: context.relevantEvidence.length,
    });

    log.append({ type: 'model_requested', runId, model: deps.model.name, purpose: 'decide' });
    const decision = await deps.model.decide(
      {
        objective: context.objective,
        entities: context.entities,
        openQuestions: context.openQuestions,
        pendingPlanSteps: context.pendingPlanSteps,
        readSourceIds: context.readSourceIds,
        triedQueries: state.triedQueries.slice(),
        failedSources: context.failedSources,
        knownCandidates: context.knownCandidates,
        toolCallsUsed: state.toolCallsUsed,
        budget: { maxToolCalls: state.budget.maxToolCalls },
      },
      signal,
    );
    log.append({ type: 'decision_made', runId, decision });

    if (decision.kind === 'escalate') {
      log.append({
        type: 'stop_evaluated',
        runId,
        shouldStop: true,
        reason: 'human_escalation',
        details: [decision.question],
      });
      stopReason = 'human_escalation';
      stopDetails = [decision.question];
      break;
    }

    if (decision.kind === 'report') {
      // 模型请求交付，但仍有未解决问题：转为明确的不确定项，不得静默宣称完成。
      const forced: string[] = [];
      for (const q of state.questions) {
        if (q.status === 'open') {
          q.status = 'inconclusive';
          forced.push(q.text);
          log.append({ type: 'question_updated', runId, questionId: q.id, status: 'inconclusive' });
        }
      }
      const reason: StopReason = forced.length > 0 ? 'partial_delivery' : 'goal_complete';
      const details = forced.length
        ? [`模型请求交付，但 ${forced.length} 个调查问题未取得证据，已记为不确定`, decision.rationale]
        : [decision.rationale];
      log.append({ type: 'stop_evaluated', runId, shouldStop: true, reason, details });
      stopReason = reason;
      stopDetails = details;
      break;
    }

    if (!isToolName(decision.tool)) {
      log.append({
        type: 'run_failed',
        runId,
        error: { code: 'invalid_tool', message: `未知工具：${decision.tool}` },
      });
      return finish(log, runId, task, state, store, 'invalid_tool', [], startedAt);
    }

    const tool = decision.tool;
    let attempt = 0;
    let handled = false;
    let producedNewInformation = false;

    while (true) {
      if (signal.aborted) {
        log.append({ type: 'run_cancelled', runId });
        return finish(log, runId, task, state, store, 'cancelled', [], startedAt);
      }
      if (state.toolCallsUsed >= state.budget.maxToolCalls) {
        log.append({
          type: 'stop_evaluated',
          runId,
          shouldStop: true,
          reason: 'budget_exhausted',
          details: [`工具调用达到上限 ${state.budget.maxToolCalls}`],
        });
        stopReason = 'budget_exhausted';
        stopDetails = [`工具调用达到上限 ${state.budget.maxToolCalls}`];
        handled = true;
        break;
      }

      state.toolCallsUsed += 1;
      const attemptStartedAt = Date.now();
      log.append({ type: 'tool_started', runId, tool, args: decision.args, attempt });
      const result = await deps.tools.execute(tool, decision.args, signal);
      const resourceId =
        typeof decision.args.id === 'string'
          ? decision.args.id
          : typeof decision.args.document_id === 'string'
            ? decision.args.document_id
            : typeof decision.args.query === 'string'
              ? decision.args.query
              : '';
      log.append({
        type: 'tool_completed',
        runId,
        tool,
        status: result.status,
        durationMs: Date.now() - attemptStartedAt,
        ...(resourceId ? { resourceId } : {}),
      });

      if (result.status === 'ok' || result.status === 'empty') {
        if (result.status === 'ok' && 'candidates' in result) {
          for (const candidate of result.candidates) {
            if (!knownCandidates.some((c) => c.sourceId === candidate.sourceId)) {
              knownCandidates.push(candidate);
              producedNewInformation = true;
            }
          }
          if (result.tool === 'search_sources' || result.tool === 'search_internal_docs') {
            const query = typeof decision.args.query === 'string' ? decision.args.query : '';
            if (!state.triedQueries.includes(query)) state.triedQueries.push(query);
            markStepDoneByKeyword(state, result.tool === 'search_sources' ? '检索公开来源' : '检索已授权内部材料');
          }
        }
        if (result.status === 'ok' && 'source' in result) {
          const source = result.source;
          state.readSourceIds.push(source.sourceId);
          markStepDoneByKeyword(state, '读取');
          const created = await ingestSource(log, runId, deps, source, store, state, signal);
          producedNewInformation = producedNewInformation || created;
        }
        if (result.status === 'empty') {
          const query = typeof decision.args.query === 'string' ? decision.args.query : '';
          if (!state.triedQueries.includes(query)) state.triedQueries.push(query);
        }
        handled = true;
        break;
      }

      const code = result.status;
      if (code === 'permission_denied') {
        log.append({ type: 'permission_checked', runId, tool, resourceId, outcome: 'deny' });
      }
      const canRetry = RETRYABLE.has(code) && attempt < state.budget.maxRetriesPerResource;
      log.append({
        type: 'recovery_decision',
        runId,
        tool,
        code,
        action: canRetry ? 'retry' : 'no_retry',
        attempt,
      });

      if (canRetry) {
        attempt += 1;
        continue;
      }

      recordFailure(state, { tool, resourceId, code, attempts: attempt + 1 });
      handled = true;
      break;
    }

    if (!handled) break;

    state.noProgressCount = producedNewInformation ? 0 : state.noProgressCount + 1;
    log.append({
      type: 'state_updated',
      runId,
      toolCallsUsed: state.toolCallsUsed,
      noProgressCount: state.noProgressCount,
    });

    if (deps.checkpoint) {
      const path = `runs/${runId}/checkpoint.json`;
      await deps.checkpoint({
        runId,
        caseId: task.caseId,
        state,
        evidence: store.list(),
        claims: store.listClaims(),
        conflicts: store.conflicts,
      });
      log.append({ type: 'checkpoint_saved', runId, path });
    }
    if (stopReason) break;
  }

  return finish(log, runId, task, state, store, stopReason, stopDetails, startedAt);
}

async function ingestSource(
  log: EventLog,
  runId: string,
  deps: RuntimeDeps,
  source: { sourceId: string; title: string; channel: 'public' | 'internal'; content: string },
  store: ReturnType<typeof createEvidenceStore>,
  state: InvestigationState,
  signal: AbortSignal,
): Promise<boolean> {
  log.append({ type: 'model_requested', runId, model: deps.model.name, purpose: 'interpret' });
  const interpretation = await deps.model.interpret(
    {
      source,
      claims: store.claims.map((c) => ({
        claimId: c.claimId,
        statement: c.statement,
        positiveTerms: c.positiveTerms,
        negativeTerms: c.negativeTerms,
      })),
    },
    signal,
  );

  let created = false;
  for (const item of interpretation.evidence) {
    // 引文完整性校验：quote 必须是原文子串，否则拒绝进入证据链。
    if (!quoteIsVerifiable(item.quote, source.content)) continue;
    const evidence = store.addEvidence({
      sourceId: item.sourceId,
      channel: item.channel,
      excerpt: item.excerpt,
      quote: item.quote,
    });
    created = true;
    log.append({
      type: 'evidence_created',
      runId,
      evidenceId: evidence.evidenceId,
      sourceId: evidence.sourceId,
      quote: evidence.quote,
    });
  }

  for (const judgement of interpretation.judgements) {
    const target = store.list().filter((e) => e.sourceId === source.sourceId);
    if (target.length === 0) continue;
    const evidenceId = target[target.length - 1]!.evidenceId;
    store.linkEvidenceToClaim(judgement.claimId, evidenceId, judgement.relation);
    const claim = store.getClaim(judgement.claimId);
    log.append({
      type: 'claim_updated',
      runId,
      claimId: judgement.claimId,
      status: claim?.status ?? 'unknown',
      relations: claim?.links.map((l) => `${l.evidenceId}:${l.relation}`) ?? [],
    });
  }

  const newConflicts = store.detectConflicts();
  for (const conflict of newConflicts) {
    log.append({ type: 'conflict_detected', runId, conflictId: conflict.conflictId, claimId: conflict.claimId });
  }

  const { derived, updatedQuestions } = syncQuestionsFromClaims(
    state,
    store.listClaims().map((c) => ({ claimId: c.claimId, status: c.status })),
  );
  for (const update of updatedQuestions) {
    log.append({ type: 'question_updated', runId, questionId: update.id, status: update.status });
  }
  for (const text of derived) {
    log.append({
      type: 'plan_updated',
      runId,
      stepId: `P${state.planSteps.length}`,
      text,
      triggeredBy: 'conflict',
    });
  }
  return created;
}

function markStepDoneByKeyword(state: InvestigationState, keyword: string): void {
  const step = state.planSteps.find((s) => s.status === 'pending' && s.text.includes(keyword));
  if (step) step.status = 'done';
}

function finish(
  log: EventLog,
  runId: string,
  task: InvestigationTask,
  state: InvestigationState,
  store: ReturnType<typeof createEvidenceStore>,
  stopReason: StopReason | null | 'cancelled' | 'invalid_tool',
  stopDetails: string[],
  startedAt: number,
): RunOutcome {
  if (stopReason === 'cancelled' || stopReason === 'invalid_tool') {
    const report = generateReport({
      state,
      claims: store.listClaims(),
      evidence: store.list(),
      conflicts: store.conflicts,
      stopReason: null,
      stopDetails,
    });
    log.append({
      type: 'report_generated',
      runId,
      status: report.status,
      missingMaterial: report.missingMaterial,
    });
    return { runId, events: log.list(), report, stopReason: null };
  }

  const report = generateReport({
    state,
    claims: store.listClaims(),
    evidence: store.list(),
    conflicts: store.conflicts,
    stopReason,
    stopDetails,
  });
  log.append({
    type: 'usage_reported',
    runId,
    toolCalls: state.toolCallsUsed,
    iterations: state.iterations,
    durationMs: Date.now() - startedAt,
    model: 'fake-deterministic',
  });
  log.append({
    type: 'report_generated',
    runId,
    status: report.status,
    missingMaterial: report.missingMaterial,
  });
  log.append({
    type: 'run_completed',
    runId,
    status: report.status,
    stopReason,
  });
  return { runId, events: log.list(), report, stopReason };
}
