// 运行详情：事件流 / 证据 / 报告三个视图。
// 真实性要求：运行失败时显示 errorMessage；报告为 partial 时显示缺失材料。
// 不做虚假进度——运行中的状态直接来自后端，前端不臆测百分比。
import { useEffect, useState } from 'react';
import { getRunDetail } from '../api';
import type { RunDetail as RunDetailData } from '../types';
import { ReportStatusBadge, StatusBadge } from './StatusBadge';

type Tab = 'events' | 'evidence' | 'report';

const TABS: { id: Tab; label: string }[] = [
  { id: 'events', label: '事件流' },
  { id: 'evidence', label: '证据' },
  { id: 'report', label: '报告' },
];

interface RunDetailViewProps {
  runId: string;
  onBack: () => void;
}

export function RunDetailView({ runId, onBack }: RunDetailViewProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('events');
  const [detail, setDetail] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = detail?.run.status ?? 'running';

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async (): Promise<void> => {
      try {
        const next = await getRunDetail(runId);
        if (cancelled) return;
        setDetail(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        // 运行中才继续轮询；结束后停止，不做无意义的空转。
        if (!cancelled && timer !== null) timer = setTimeout(() => void load(), 500);
      }
    };

    void load();
    // 首轮未拿到 status 时先按运行中处理，拿到后由 load 内部决定是否继续。
    timer = setTimeout(() => void load(), 500);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runId, status === 'running']);

  if (error !== null && detail === null) {
    return (
      <div className="error-banner" role="alert">
        加载运行详情失败：{error}
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="stack" aria-busy="true" aria-label="正在加载运行详情">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  const { run, evidence, claims, conflicts, report, events } = detail;

  return (
    <div className="stack">
      <div className="row">
        <button type="button" onClick={onBack} data-testid="back-to-tasks">
          返回任务
        </button>
        <h2 className="mono">{run.runId}</h2>
        <StatusBadge status={run.status} />
      </div>

      <div className="card stack" style={{ gap: 'var(--space-2)' }}>
        <p className="small muted" style={{ margin: 0 }}>
          停止原因：{run.stopReason ?? '（尚未结束，未知）'} · 工具调用 {run.toolCalls} 次 · 证据{' '}
          {run.evidenceCount} 条 · 冲突 {run.conflictCount} 处
        </p>
        {run.errorMessage !== null ? (
          <div className="error-banner" role="alert" data-testid="run-error">
            运行失败：{run.errorMessage}
          </div>
        ) : null}
      </div>

      {report !== null && report.status === 'partial' ? (
        <div className="notice" role="status" data-testid="partial-notice">
          本次为有限结果：{report.missingMaterial.length} 项材料缺失，不得推断为已确认或已排除。
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'events' ? (
        <div className="card" data-testid="panel-events">
          <h3>事件流（{events.length} 条）</h3>
          {events.length === 0 ? (
            <p className="small muted">暂无事件</p>
          ) : (
            <div>
              {events.map((e) => (
                <div key={e.sequence} className="event-line">
                  #{e.sequence} {e.type}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div className="card stack" data-testid="panel-evidence">
          <h3>证据（{evidence.length} 条）</h3>
          {evidence.length === 0 ? (
            <p className="small muted" data-testid="evidence-empty">
              未取得任何证据。这表示现有材料不足以支撑结论，不应推断为已排除。
            </p>
          ) : (
            evidence.map((e) => (
              <div
                key={e.evidenceId}
                className={e.channel === 'internal' ? 'evidence-item internal' : 'evidence-item'}
                data-testid={`evidence-${e.evidenceId}`}
              >
                <div className="row small">
                  <strong className="mono">{e.evidenceId}</strong>
                  <span className="mono muted">来源 {e.sourceId}</span>
                  <span className="badge">{e.channel === 'internal' ? '内部' : '公开'}</span>
                </div>
                <p style={{ margin: 'var(--space-1) 0' }}>{e.excerpt}</p>
                <p className="small muted" style={{ margin: 0 }}>
                  引文：{e.quote}
                </p>
              </div>
            ))
          )}

          <h3>结论（{claims.length} 项）</h3>
          {claims.length === 0 ? (
            <p className="small muted">尚无结论</p>
          ) : (
            <ul role="list" className="small" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
              {claims.map((c) => (
                <li key={c.claimId}>
                  <strong>{c.claimId}</strong>：{c.statement} —— 状态 {c.status}
                </li>
              ))}
            </ul>
          )}

          {conflicts.length > 0 ? (
            <>
              <h3>冲突（{conflicts.length} 处）</h3>
              <ul role="list" className="small" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                {conflicts.map((c) => (
                  <li key={c.conflictId}>
                    {c.conflictId}：主张 {c.claimId} 上支持来源与反对来源并存（{c.status}）
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === 'report' ? (
        <div className="card stack" data-testid="panel-report">
          <div className="row">
            <h3>调查报告</h3>
            {report !== null ? <ReportStatusBadge status={report.status} /> : null}
          </div>
          {report === null ? (
            <p className="small muted">{run.status === 'running' ? '运行尚未结束，报告未生成' : '未生成报告'}</p>
          ) : (
            <>
              {report.missingMaterial.length > 0 ? (
                <div className="stack" style={{ gap: 'var(--space-1)' }}>
                  <strong className="small">缺失材料</strong>
                  <ul role="list" className="small muted" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                    {report.missingMaterial.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <pre className="report-body" data-testid="report-markdown">
                {report.markdown}
              </pre>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
