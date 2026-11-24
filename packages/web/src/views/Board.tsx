import { useState } from 'react';
import {
  delegateTask,
  deleteTask,
  sendEvent,
  startQueue,
  useApiMutation,
  useQueue,
  useTasks,
} from '../queries.ts';
import { COLUMNS, FINISHED, NEEDS_USER } from '../taskView.ts';
import { AddTaskForm } from './AddTaskForm.tsx';
import { TaskCard } from './TaskCard.tsx';

export function Board() {
  const tasks = useTasks();
  const [hideFinished, setHideFinished] = useState(false);
  const event = useApiMutation((v: { id: number; event: string }) => sendEvent(v.id, v.event));
  const del = useApiMutation((id: number) => deleteTask(id));
  const queue = useQueue();
  const start = useApiMutation(() => startQueue());
  const delegate = useApiMutation((id: number) => delegateTask(id));
  const error = tasks.error ?? event.error ?? del.error ?? start.error ?? delegate.error;

  const all = tasks.data ?? [];
  const columns = COLUMNS.filter(
    (c) => !(hideFinished && c.statuses.every((s) => FINISHED.includes(s))),
  );

  const queued = all.filter((t) => t.status === 'queued_analysis').length;
  const q = queue.data;
  const startDisabledReason = !q
    ? 'The queue state is not loaded'
    : q.autoAnalysis
      ? 'Automatic analysis is on, so queued tasks start by themselves'
      : q.started
        ? 'The queue is already started for this session'
        : queued === 0
          ? 'No task is queued for analysis'
          : '';

  return (
    <section>
      <AddTaskForm />
      <div className="toolbar">
        <label>
          <input
            type="checkbox"
            checked={hideFinished}
            onChange={(e) => setHideFinished(e.target.checked)}
          />{' '}
          Hide done and cancelled
        </label>
        <span className="queue-control">
          <button
            type="button"
            disabled={startDisabledReason !== '' || start.isPending}
            title={startDisabledReason || 'Start analysing the queued tasks'}
            onClick={() => start.mutate(undefined)}
          >
            Start queue
          </button>
          <span className="queue-note">
            {q?.started || q?.autoAnalysis
              ? '▶ Analysis is running for queued tasks'
              : 'Starts analysis of queued tasks for this session only'}
          </span>
        </span>
      </div>
      {error && (
        <div role="alert" className="error">
          {error.message}
        </div>
      )}
      {tasks.isSuccess && all.length === 0 && <p>No tasks yet</p>}
      <div className="board">
        {columns.map((col) => {
          const inCol = all.filter((t) => col.statuses.includes(t.status));
          const needYou = col.statuses.some((s) => NEEDS_USER.includes(s));
          return (
            <div key={col.id} className="column" data-testid={`column-${col.id}`}>
              <header>
                <h2 data-testid="column-title">{col.title}</h2>
                <span data-testid="column-count" className="count">
                  {inCol.length}
                </span>
                {needYou && inCol.length > 0 && (
                  <span className="need-you">{inCol.length} need you</span>
                )}
              </header>
              {inCol.length === 0 ? (
                <p className="empty">No tasks</p>
              ) : (
                inCol.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    onEvent={(task, e) => event.mutate({ id: task.id, event: e })}
                    onDelete={(task) => del.mutate(task.id)}
                    onDelegate={(task) => delegate.mutate(task.id)}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
