// 状态标记。无障碍要求：颜色不能是唯一指示器，因此每个状态都带文字。
import type { ReportStatus, RunStatus } from '../types';

const RUN_LABEL: Record<RunStatus, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const RUN_CLASS: Record<RunStatus, string> = {
  running: 'badge badge-running',
  completed: 'badge badge-completed',
  failed: 'badge badge-failed',
  cancelled: 'badge badge-cancelled',
};

export function StatusBadge({ status }: { status: RunStatus }): React.JSX.Element {
  return <span className={RUN_CLASS[status]}>{RUN_LABEL[status]}</span>;
}

/**
 * 报告状态。partial 必须显式可见——不能让「部分结果」看起来像完整交付。
 */
export function ReportStatusBadge({ status }: { status: ReportStatus }): React.JSX.Element {
  const label = status === 'complete' ? '完整报告' : '有限结果（证据不足）';
  const cls = status === 'complete' ? 'badge badge-completed' : 'badge badge-partial';
  return <span className={cls}>{label}</span>;
}
