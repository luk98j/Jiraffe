import { Link } from 'react-router';
import type { TaskDto } from '@jiraffe/core';
import { STATUS_VIEW, type ActionId } from '../statusView.ts';
import { NEEDS_USER, analyseDisabledReason } from '../taskView.ts';

const LABEL: Record<ActionId, string> = {
  analyse: 'Analyse',
  cancel: 'Cancel',
  answer: 'Answer',
  delegate: 'Delegate',
  reanalyse: 'Re-analyse',
  logs: 'Logs',
  resume: 'Resume',
  diff: 'Show diff',
  accept: 'Accept',
  error: 'Show error',
  retry: 'Retry',
  delete: 'Delete',
};
const EVENT: Partial<Record<ActionId, string>> = {
  analyse: 'enqueue',
  cancel: 'cancel',
  reanalyse: 'reanalyse',
  retry: 'retry',
  resume: 'resume',
  accept: 'review_accepted',
};
export const DELETE_CONFIRM = 'Delete this task from the local board? Nothing changes in Jira.';

interface Props {
  task: TaskDto;
  onEvent(task: TaskDto, event: string): void;
  onDelete(task: TaskDto): void;
  onDelegate?(task: TaskDto): void;
}

export function TaskCard({ task, onEvent, onDelete, onDelegate }: Props) {
  const view = STATUS_VIEW[task.status];
  const highlight = NEEDS_USER.includes(task.status) ? ' card-highlight' : '';

  const action = (id: ActionId) => {
    const label = LABEL[id];
    if (id === 'answer')
      return (
        <Link key={id} className="action" to={`/tasks/${task.id}?focus=chat`}>
          {label}
        </Link>
      );
    if (id === 'logs' || id === 'diff' || id === 'error')
      return (
        <Link key={id} className="action" to={`/tasks/${task.id}`}>
          {label}
        </Link>
      );
    if (id === 'delegate') {
      // The reason is the engine's canDelegate() text, shown as the tooltip when disabled.
      const ok = task.delegate?.ok === true;
      return (
        <button
          key={id}
          type="button"
          disabled={!ok}
          title={
            ok
              ? 'Delegate this task for execution'
              : (task.delegate?.reason ?? 'Delegate is not available')
          }
          onClick={() => onDelegate?.(task)}
        >
          {label}
        </button>
      );
    }
    if (id === 'analyse') {
      const reason = analyseDisabledReason(task);
      return (
        <button
          key={id}
          type="button"
          disabled={reason !== null}
          {...(reason ? { title: reason } : {})}
          onClick={() => onEvent(task, 'enqueue')}
        >
          {label}
        </button>
      );
    }
    if (id === 'delete') {
      return (
        <button
          key={id}
          type="button"
          onClick={() => window.confirm(DELETE_CONFIRM) && onDelete(task)}
        >
          {label}
        </button>
      );
    }
    // biome-ignore lint/style/noNonNullAssertion: Non-event action IDs are handled above.
    const event = EVENT[id]!;
    return (
      <button key={id} type="button" onClick={() => onEvent(task, event)}>
        {label}
      </button>
    );
  };

  return (
    <article data-testid={`card-${task.key}`} className={`card ${view.colorClass}${highlight}`}>
      <div className="card-head">
        <span className="state">
          <span data-testid="status-icon" aria-hidden="true">
            {view.icon}
          </span>{' '}
          <span>{view.label}</span>
        </span>
        <span className="badge">{task.source === 'jira' ? 'Jira' : 'Local'}</span>
      </div>
      <Link className="card-key" to={`/tasks/${task.id}`}>
        {task.key}
      </Link>
      <div className="card-title">{task.title}</div>
      <div className="card-repo">{task.repoPath ?? 'No repository'}</div>
      <div className="badges">
        {task.hasNewComment && <span className="badge badge-info">New comment</span>}
        {task.bodyChangedAfterAnalysis && (
          <span className="badge badge-warn">Description changed in Jira</span>
        )}
        {task.jiraClosed && <span className="badge badge-warn">Closed in Jira</span>}
      </div>
      <div className="actions">{view.actions.map(action)}</div>
    </article>
  );
}
