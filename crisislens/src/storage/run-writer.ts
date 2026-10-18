// 运行产物落盘：trace.jsonl 是 append-only 事件日志的物化，
// 其余文件是快照缓存。二者不一致时以 trace 为准。
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentEvent } from '../runtime/events.ts';
import type { EventSink } from '../runtime/event-log.ts';
import type { RunSnapshot } from '../runtime/runtime.ts';
import type { Report } from '../core/report.ts';

export interface RunArtifacts {
  dir: string;
  tracePath: string;
  reportPath: string;
  statePath: string;
  evidencePath: string;
  claimsPath: string;
  summaryPath: string;
}

export function createRunWriter(root: string, runId: string): RunArtifacts & { sink: EventSink } {
  const dir = resolve(root, runId);
  mkdirSync(dir, { recursive: true });
  const tracePath = resolve(dir, 'trace.jsonl');
  writeFileSync(tracePath, '', 'utf8');
  const sink: EventSink = {
    write(event: AgentEvent) {
      appendFileSync(tracePath, `${JSON.stringify(event)}\n`, 'utf8');
    },
    close() {
      /* append-only，无需关闭 */
    },
  };
  return {
    dir,
    sink,
    tracePath,
    reportPath: resolve(dir, 'report.md'),
    statePath: resolve(dir, 'final_state.json'),
    evidencePath: resolve(dir, 'evidence.json'),
    claimsPath: resolve(dir, 'claims.json'),
    summaryPath: resolve(dir, 'summary.json'),
  };
}

export function writeRunArtifacts(
  artifacts: RunArtifacts,
  snapshot: RunSnapshot,
  report: Report,
  events: AgentEvent[],
): void {
  writeFileSync(artifacts.reportPath, report.markdown, 'utf8');
  writeFileSync(artifacts.statePath, `${JSON.stringify(snapshot.state, null, 2)}\n`, 'utf8');
  writeFileSync(artifacts.evidencePath, `${JSON.stringify(snapshot.evidence, null, 2)}\n`, 'utf8');
  writeFileSync(artifacts.claimsPath, `${JSON.stringify(snapshot.claims, null, 2)}\n`, 'utf8');
  writeFileSync(
    artifacts.summaryPath,
    `${JSON.stringify(
      {
        runId: snapshot.runId,
        caseId: snapshot.caseId,
        reportStatus: report.status,
        stopReason: report.stopReason,
        missingMaterial: report.missingMaterial,
        conflicts: snapshot.conflicts,
        eventCount: events.length,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
