// 任务详情：调查范围 + 运行历史 + 启动调查。
import { useEffect, useState } from 'react';
import { getTask, startRun } from '../api';
import type { TaskDetail as TaskDetailData, RunSummary } from '../types';
import { StatusBadge } from './StatusBadge';

interface TaskDetailViewProps {
  taskId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}

export function TaskDetailView({ taskId, onBack, onOpenRun }: TaskDetailViewProps): React.JSX.Element {
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await getTask(taskId);
        if (cancelled) return;
        setTask(next.task);
        setRuns(next.runs);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function start(): Promise<void> {
    setIsStarting(true);
    setStartError(null);
    try {
      const { runId } = await startRun(taskId);
      onOpenRun(runId);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setIsStarting(false);
    }
  }

  if (error !== null && task === null) {
    return (
      <div className="error-banner" role="alert">
        加载任务失败：{error}
      </div>
    );
  }

  if (task === null) {
    return (
      <div className="stack" aria-busy="true" aria-label="正在加载任务">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <button type="button" onClick={onBack} data-testid="back-to-list">
          返回列表
        </button>
        <h2>{task.userTask}</h2>
      </div>

      <div className="card stack" style={{ gap: 'var(--space-2)' }}>
        <p className="small muted" style={{ margin: 0 }}>
          场景 {task.caseId} · 调查对象 {task.entities.join('、') || '（未指定）'}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          预算：工具调用上限 {task.budget.maxToolCalls} · 迭代上限 {task.budget.maxIterations} · 单资源重试上限{' '}
          {task.budget.maxRetriesPerResource}
        </p>
      </div>

      <div className="card stack" style={{ gap: 'var(--space-2)' }}>
        <h3>调查问题（{task.questions.length} 项）</h3>
        <ul role="list" className="small" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
          {task.questions.map((q) => (
            <li key={q.id}>
              [{q.id}] {q.text}
            </li>
          ))}
        </ul>
      </div>

      {startError !== null ? (
        <div className="error-banner" role="alert">
          启动失败：{startError}
        </div>
      ) : null}

      <div className="row">
        <button type="button" className="primary" onClick={() => void start()} disabled={isStarting} data-testid="start-run">
          {isStarting ? '启动中…' : '开始调查'}
        </button>
      </div>

      <div className="card stack" style={{ gap: 'var(--space-2)' }}>
        <h3>运行历史（{runs.length} 次）</h3>
        {runs.length === 0 ? (
          <p className="small muted" data-testid="runs-empty">
            尚未运行过调查
          </p>
        ) : (
          <ul role="list" className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {runs.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  className="task-row"
                  onClick={() => onOpenRun(r.runId)}
                  data-testid={`run-row-${r.runId}`}
                >
                  <span className="stack" style={{ gap: 'var(--space-1)' }}>
                    <span className="mono">{r.runId}</span>
                    <span className="small muted">
                      证据 {r.evidenceCount} 条 · 冲突 {r.conflictCount} 处
                      {r.stopReason !== null ? ` · ${r.stopReason}` : ''}
                    </span>
                  </span>
                  <StatusBadge status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
