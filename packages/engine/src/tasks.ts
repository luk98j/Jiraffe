import type { MessageDto } from '@jiraffe/core';
import { ConflictError, TaskNotFoundError, ValidationError, type TaskDto } from '@jiraffe/core';
import {
  getTaskDto,
  insertJournal,
  listDeletedTaskDtos,
  listMessages,
  listTaskDtos,
  setDeletedAt,
  setRepoPath,
} from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { getSetting } from './settings.ts';
import { createTask } from './createTask.ts';

export function createLocalTask(
  ctx: Ctx,
  input: { title: string; description: string; repoPath: string },
): TaskDto {
  return write(ctx, (tx, outbox) =>
    createTask(ctx, tx, outbox, {
      source: 'local',
      title: input.title,
      body: input.description,
      repoPath: input.repoPath,
    }),
  );
}

/** Returns the task, including soft-deleted ones. */
export function getTask(ctx: Ctx, id: number): TaskDto {
  const t = getTaskDto(ctx.db, id);
  if (!t) throw new TaskNotFoundError();
  return t;
}

export function setRepository(ctx: Ctx, id: number, repoPath: string): void {
  const path = repoPath.trim();
  if (!path) throw new ValidationError('Repository is required', 'repoPath');
  write(ctx, (tx, outbox) => {
    const t = getTaskDto(tx, id);
    if (!t || t.deletedAt) throw new TaskNotFoundError();
    setRepoPath(tx, id, path, ctx.clock().toISOString());
    outbox.changed();
  });
}

export function deleteTask(ctx: Ctx, id: number): void {
  write(ctx, (tx, outbox) => {
    const t = getTaskDto(tx, id);
    if (!t || t.deletedAt) throw new TaskNotFoundError();
    if (t.status === 'running') throw new ConflictError('Cancel the task first');
    const now = ctx.clock().toISOString();
    setDeletedAt(tx, id, now, now);
    insertJournal(tx, { at: now, taskKey: t.key, status: t.status, action: 'task_deleted' });
    outbox.changed();
  });
}

export function restoreTask(ctx: Ctx, id: number): void {
  write(ctx, (tx, outbox) => {
    const t = getTaskDto(tx, id);
    if (!t) throw new TaskNotFoundError();
    if (!t.deletedAt) throw new ConflictError('Task is not deleted');
    const now = ctx.clock().toISOString();
    setDeletedAt(tx, id, null, now);
    insertJournal(tx, { at: now, taskKey: t.key, status: t.status, action: 'task_restored' });
    outbox.changed();
  });
}

export function listTasks(ctx: Ctx): TaskDto[] {
  return listTaskDtos(ctx.db);
}

/** Soft-deleted tasks still inside the retention window (boundary included). */
export function listDeleted(ctx: Ctx): TaskDto[] {
  const days = getSetting(ctx, 'retention_days');
  return listDeletedTaskDtos(
    ctx.db,
    new Date(ctx.clock().getTime() - days * 86_400_000).toISOString(),
  );
}

/** Task plus its messages; a soft-deleted task counts as not found. */
export function getTaskDetail(ctx: Ctx, id: number): { task: TaskDto; messages: MessageDto[] } {
  const task = getTaskDto(ctx.db, id);
  if (!task || task.deletedAt) throw new TaskNotFoundError();
  return { task, messages: listMessages(ctx.db, id) };
}
