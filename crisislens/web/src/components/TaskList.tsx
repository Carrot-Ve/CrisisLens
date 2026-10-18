// 任务列表。三种状态都必须有真实呈现：加载中、错误、空列表。
import type { TaskSummary } from '../types';
import { StatusBadge } from './StatusBadge';

interface TaskListProps {
  tasks: TaskSummary[];
  isLoading: boolean;
  error: string | null;
  onSelect: (taskId: string) => void;
}

export function TaskList({ tasks, isLoading, error, onSelect }: TaskListProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="stack" aria-busy="true" aria-label="正在加载任务">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="error-banner" role="alert">
        加载任务列表失败：{error}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="empty-state" role="status">
        <h3>还没有调查任务</h3>
        <p className="small">创建第一个任务后，系统会检索公开来源与已授权内部资料，建立可追溯的证据链。</p>
      </div>
    );
  }

  return (
    <ul role="list" className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {tasks.map((task) => (
        <li key={task.taskId}>
          <button
            type="button"
            className="task-row"
            onClick={() => onSelect(task.taskId)}
            data-testid={`task-row-${task.taskId}`}
          >
            <span className="stack" style={{ gap: 'var(--space-1)' }}>
              <span>{task.userTask}</span>
              <span className="small muted">
                {task.caseId} · 证据 {task.evidenceCount} 条 · 冲突 {task.conflictCount} 处
                {task.latestStopReason !== null ? ` · 停止原因：${task.latestStopReason}` : ''}
              </span>
            </span>
            <span>{task.latestStatus !== null ? <StatusBadge status={task.latestStatus} /> : null}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
