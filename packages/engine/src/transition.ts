import {
  TaskNotFoundError,
  TaskNotReadyError,
  resolveTransition,
  type Status,
  type TransitionEvent,
} from '@jiraffe/core';
import { getTaskDto, insertEvent, insertJournal, type Tx } from '@jiraffe/db';
import { applyStatusChange } from '@jiraffe/db/status-writer';
import { write, type Ctx, type Outbox } from './context.ts';

export type TransitionResult =
  | { changed: false; status: Status }
  | { changed: true; from: Status; to: Status };

export interface TransitionOptions {
  pauseReason?: string;
  resumeAt?: string;
}

/** Runs inside the caller's transaction so composite operations commit as one. */
export function applyTransition(
  ctx: Ctx,
  tx: Tx,
  outbox: Outbox,
  taskId: number,
  event: TransitionEvent,
  opts: TransitionOptions = {},
): TransitionResult {
  const task = getTaskDto(tx, taskId);
  if (!task || task.deletedAt) throw new TaskNotFoundError();

  const res = resolveTransition(task.status, event, task.statusBeforePause);
  if (res.kind === 'noop') return { changed: false, status: task.status };

  const from = task.status;
  const to = res.to;
  if (event === 'enqueue' && !task.repoPath?.trim()) {
    throw new TaskNotReadyError('Choose a repository first');
  }

  const now = ctx.clock().toISOString();
  const entersPause = to === 'paused_quota';
  applyStatusChange(tx, taskId, {
    status: to,
    statusBeforePause: entersPause ? from : event === 'resume' ? null : task.statusBeforePause,
    pauseReason: entersPause ? (opts.pauseReason ?? null) : event === 'resume' ? null : task.pauseReason,
    resumeAt: entersPause ? (opts.resumeAt ?? null) : event === 'resume' ? null : task.resumeAt,
    ...(event === 'reanalyse' ? { bodyChangedAfterAnalysis: false as const } : {}),
    updatedAt: now,
  });
  insertEvent(tx, { taskId, type: event, payload: { from, to }, createdAt: now });
  // The journal row goes last so a failure here proves the whole change rolls back.
  insertJournal(tx, { at: now, taskKey: task.key, status: to, action: 'status_changed', detail: `${from} to ${to}` });
  outbox.emitEvent({ taskId, type: event, from, to });
  outbox.changed();
  return { changed: true, from, to };
}

export function transition(
  ctx: Ctx,
  taskId: number,
  event: TransitionEvent,
  opts?: TransitionOptions,
): TransitionResult {
  return write(ctx, (tx, outbox) => applyTransition(ctx, tx, outbox, taskId, event, opts));
}
