// 创建调查任务。
// 调查问题默认取自所选场景的「澄清调查范围」示例措辞，用户可继续使用默认值。
// 这些措辞是判据（出现什么算支持/反对），不是预期答案。
import { useEffect, useState } from 'react';
import { createTask, listCases } from '../api';
import type { CaseSpec } from '../api';

interface NewTaskFormProps {
  onCreated: (taskId: string) => void;
  onCancel: () => void;
}

export function NewTaskForm({ onCreated, onCancel }: NewTaskFormProps): React.JSX.Element {
  const [cases, setCases] = useState<CaseSpec[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string>('');
  const [userTask, setUserTask] = useState<string>('');
  const [entities, setEntities] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCases()
      .then(({ cases: list }) => {
        if (cancelled) return;
        setCases(list);
        const first = list[0];
        if (first !== undefined) {
          setSelectedCaseId(first.caseId);
          setUserTask(first.userTask);
          setEntities(first.entities.join('、'));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = cases.find((c) => c.caseId === selectedCaseId);

  function selectCase(caseId: string): void {
    const next = cases.find((c) => c.caseId === caseId);
    setSelectedCaseId(caseId);
    if (next !== undefined) {
      setUserTask(next.userTask);
      setEntities(next.entities.join('、'));
    }
  }

  async function submit(): Promise<void> {
    if (active === undefined) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const { task } = await createTask({
        caseId: active.caseId,
        userTask,
        entities: entities
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        questions: active.questions,
      });
      onCreated(task.taskId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setIsSubmitting(false);
    }
  }

  if (loadError !== null) {
    return (
      <div className="error-banner" role="alert">
        无法加载调查场景：{loadError}
      </div>
    );
  }

  if (cases.length === 0) {
    return (
      <div className="empty-state" role="status">
        正在加载可选调查场景…
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="stack" style={{ gap: 'var(--space-1)' }}>
        <span>调查场景</span>
        <select
          value={selectedCaseId}
          onChange={(e) => selectCase(e.target.value)}
          aria-label="调查场景"
          data-testid="case-select"
        >
          <optgroup label="基础事件族">
            {cases
              .filter((c) => c.kind === 'baseline')
              .map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  {c.caseId} · {c.label}
                </option>
              ))}
          </optgroup>
          <optgroup label="挑战变体（人为构造的压力场景）">
            {cases
              .filter((c) => c.kind === 'challenge')
              .map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  {c.label}
                </option>
              ))}
          </optgroup>
        </select>
      </label>

      {active?.kind === 'challenge' ? (
        <p className="small muted" style={{ margin: 0 }} role="note" data-testid="challenge-note">
          这是人为构造的压力场景：{active.label}。它用于检验系统的受限行为，
          <strong>不是</strong>实际运行发现的 Bad Case。
        </p>
      ) : null}

      <label className="stack" style={{ gap: 'var(--space-1)' }}>
        <span>调查任务</span>
        <textarea
          rows={3}
          value={userTask}
          onChange={(e) => setUserTask(e.target.value)}
          data-testid="usertask-input"
        />
      </label>

      <label className="stack" style={{ gap: 'var(--space-1)' }}>
        <span>调查对象</span>
        <input value={entities} onChange={(e) => setEntities(e.target.value)} />
      </label>

      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <h3>调查问题（{active?.questions.length ?? 0} 项）</h3>
        <ul role="list" className="small muted" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
          {(active?.questions ?? []).map((q) => (
            <li key={q.id}>
              [{q.id}] {q.text}
            </li>
          ))}
        </ul>
      </div>

      {submitError !== null ? (
        <div className="error-banner" role="alert" data-testid="create-error">
          创建失败：{submitError}
        </div>
      ) : null}

      <div className="row">
        <button type="submit" className="primary" disabled={isSubmitting} data-testid="create-submit">
          {isSubmitting ? '创建中…' : '创建任务'}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
