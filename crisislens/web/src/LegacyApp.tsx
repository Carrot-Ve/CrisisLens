// 应用外壳与视图路由。不引入 react-router：只有四个视图，用判别联合即可，
// 少一个依赖、少一层路由抽象。
import { useCallback, useEffect, useState } from 'react';
import { listTasks } from './api';
import type { TaskSummary } from './types';
import { NewTaskForm } from './components/NewTaskForm';
import { RunDetailView } from './components/RunDetailView';
import { TaskDetailView } from './components/TaskDetailView';
import { TaskList } from './components/TaskList';

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'task'; taskId: string }
  | { kind: 'run'; runId: string };

export function LegacyApp(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { tasks: next } = await listTasks();
      setTasks(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, view.kind]);

  return (
    <div>
      <header className="masthead">
        <div className="masthead-inner">
          <h1>CrisisLens</h1>
          <span className="small muted">舆情调查 Agent · 带引用的证据链与有限结果</span>
        </div>
      </header>

      <main className="layout stack">
        {view.kind === 'list' ? (
          <>
            <div className="row">
              <h2>调查任务</h2>
              <button
                type="button"
                className="primary"
                onClick={() => setView({ kind: 'create' })}
                data-testid="new-task"
              >
                新建任务
              </button>
            </div>
            <TaskList
              tasks={tasks}
              isLoading={isLoading}
              error={error}
              onSelect={(taskId) => setView({ kind: 'task', taskId })}
            />
          </>
        ) : null}

        {view.kind === 'create' ? (
          <>
            <h2>新建调查任务</h2>
            <NewTaskForm
              onCreated={(taskId) => setView({ kind: 'task', taskId })}
              onCancel={() => setView({ kind: 'list' })}
            />
          </>
        ) : null}

        {view.kind === 'task' ? (
          <TaskDetailView
            taskId={view.taskId}
            onBack={() => setView({ kind: 'list' })}
            onOpenRun={(runId) => setView({ kind: 'run', runId })}
          />
        ) : null}

        {view.kind === 'run' ? (
          <RunDetailView runId={view.runId} onBack={() => setView({ kind: 'list' })} />
        ) : null}
      </main>
    </div>
  );
}
