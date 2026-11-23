import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskDto, TaskExtrasDto } from '@jiraffe/core';
import {
  delegateTask,
  deleteTaskWith,
  sendEvent,
  useApiMutation,
  useDiff,
  useLogs,
  useSettings,
} from '../queries.ts';
import { DELETE_CONFIRM } from './TaskCard.tsx';

type Extras = Pick<TaskExtrasDto, 'delegate' | 'lastError' | 'restartsInWorktree' | 'hasWorktree'>;

const Err = ({ error }: { error: Error | null }) =>
  error && (
    <div role="alert" className="error">
      {error.message}
    </div>
  );

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="empty">None</p>
      ) : (
        <ul>
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DelegatePanel({ task, extras }: { task: TaskDto; extras: Extras }) {
  const settings = useSettings();
  const go = useApiMutation(() => delegateTask(task.id));
  if (task.status !== 'ready_to_delegate') return null;
  const { ok, reason, permissions } = extras.delegate;
  const allowed = (settings.data?.values.allowed_tools as string[] | undefined) ?? [];
  return (
    <section aria-label="Delegate" className="delegate">
      <h3>Delegate</h3>
      <List title="Permissions proposed by the analysis (not applied)" items={permissions} />
      <List title="Allowed tools (from settings, the only list the agent gets)" items={allowed} />
      {!ok && (
        <p className="blocked">
          <span aria-hidden="true">⛔</span> Cannot delegate: {reason}
        </p>
      )}
      <button
        type="button"
        disabled={!ok || go.isPending}
        title={ok ? 'Delegate this task for execution' : (reason ?? '')}
        onClick={() => go.mutate(undefined)}
      >
        Delegate
      </button>
      <Err error={go.error} />
    </section>
  );
}

export function LogsPanel({ task }: { task: TaskDto }) {
  const q = useLogs(task.id, true);
  const lines = q.data?.lines ?? [];
  return (
    <section aria-label="Logs" className={lines.length === 0 ? 'empty-area' : 'logs'}>
      <h3>Logs</h3>
      {lines.length === 0 ? (
        <p>Nothing here yet</p>
      ) : (
        <pre data-testid="log-lines">
          {lines.map((l) => (
            <div key={l.id} className={`log-${l.stream}`}>
              [{l.stream}] {l.text}
            </div>
          ))}
        </pre>
      )}
      {q.data?.truncated && (
        <p className="warning">
          <span aria-hidden="true">⚠</span> Log storage stopped at 5 MiB. The run continues.
        </p>
      )}
    </section>
  );
}

export function DiffPanel({ task }: { task: TaskDto }) {
  const q = useDiff(task.id, task.status === 'review');
  return (
    <section aria-label="Diff" className={q.data ? 'diff' : 'empty-area'}>
      <h3>Diff</h3>
      {q.data ? (
        <>
          <pre data-testid="diff-text">{q.data.diff || '(no changes)'}</pre>
          {q.data.truncated && (
            <p className="warning">
              <span aria-hidden="true">⚠</span> The diff was cut at 1 MiB.
            </p>
          )}
        </>
      ) : (
        <p>Nothing here yet</p>
      )}
      <Err error={q.error} />
    </section>
  );
}

export function ReviewActions({ task, extras }: { task: TaskDto; extras: Extras }) {
  const accept = useApiMutation(() => sendEvent(task.id, 'review_accepted'));
  return (
    <>
      {extras.restartsInWorktree && (
        <div role="status" className="warning">
          <span aria-hidden="true">⚠</span> Execution restarts in the existing worktree
        </div>
      )}
      {task.status === 'failed' && extras.lastError && (
        <section aria-label="Error" className="run-error">
          <h3>
            <span aria-hidden="true">✖</span> Show error
          </h3>
          <p>{extras.lastError.message}</p>
          {extras.lastError.tail && <pre>{extras.lastError.tail}</pre>}
        </section>
      )}
      {task.status === 'review' && (
        <button type="button" onClick={() => accept.mutate(undefined)}>
          Accept
        </button>
      )}
      <Err error={accept.error} />
    </>
  );
}

export function DeleteTask({ task, hasWorktree }: { task: TaskDto; hasWorktree: boolean }) {
  const [remove, setRemove] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const navigate = useNavigate();
  const del = useApiMutation(async () => {
    const r = await deleteTaskWith(task.id, remove);
    if (r?.removalError) setWarning(`The task was deleted, but removal failed: ${r.removalError}`);
    else navigate('/');
  });
  if (!hasWorktree) return null;
  return (
    <section aria-label="Delete task">
      <h3>Delete task</h3>
      <label>
        <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />{' '}
        Also remove the worktree and branch
      </label>
      <button
        type="button"
        disabled={task.status === 'running'}
        onClick={() => window.confirm(DELETE_CONFIRM) && del.mutate(undefined)}
      >
        Delete task
      </button>
      {warning && (
        <div role="alert" className="error">
          {warning}
        </div>
      )}
      <Err error={del.error} />
    </section>
  );
}
