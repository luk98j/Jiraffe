import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Statement } from 'better-sqlite3';
import type { TaskDto } from '@jiraffe/core';
import type { Db, Tx } from './client.ts';
import { tasks } from './schema.ts';

// "New comment" (A10): a user or Jira message newer than the start of the latest
// completed analysis run (a message that arrived while that run was working was not
// in its prompt), or newer than task creation when there is none.
const hasNewComment = sql<number>`exists (
  select 1 from messages m
  where m.task_id = tasks.id
    and (m.role = 'user' or m.source = 'jira')
    and m.created_at > coalesce(
      (select max(r.started_at) from runs r
        where r.task_id = tasks.id and r.kind = 'analysis' and r.end_reason = 'completed'),
      tasks.created_at)
)`;

function toDto(r: typeof tasks.$inferSelect & { newComment: number }): TaskDto {
  return {
    id: r.id,
    source: r.source,
    key: (r.jiraKey ?? r.localKey) as string,
    jiraKey: r.jiraKey,
    localKey: r.localKey,
    title: r.title,
    body: r.body,
    repoPath: r.repoPath,
    status: r.status,
    statusBeforePause: r.statusBeforePause,
    priority: r.priority,
    pauseReason: r.pauseReason,
    resumeAt: r.resumeAt,
    jiraClosed: r.jiraClosed,
    bodyChangedAfterAnalysis: r.bodyChangedAfterAnalysis,
    hasNewComment: r.newComment === 1,
    closedInJiraAt: r.closedInJiraAt,
    deletedAt: r.deletedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const select = (db: Db | Tx) => db.select({ t: tasks, newComment: hasNewComment }).from(tasks);

export function getTaskDto(db: Db | Tx, id: number): TaskDto | undefined {
  const r = select(db).where(eq(tasks.id, id)).get();
  return r && toDto({ ...r.t, newComment: r.newComment });
}

export function setRepoPath(tx: Db | Tx, id: number, repoPath: string, now: string): void {
  tx.update(tasks).set({ repoPath, updatedAt: now }).where(eq(tasks.id, id)).run();
}

/** Soft delete (a date) or restore (null). Never touches status. */
export function setDeletedAt(tx: Db | Tx, id: number, deletedAt: string | null, now: string): void {
  tx.update(tasks).set({ deletedAt, updatedAt: now }).where(eq(tasks.id, id)).run();
}

/** Board tasks (not deleted), oldest first. */
export function listTaskDtos(db: Db | Tx): TaskDto[] {
  return select(db)
    .where(isNull(tasks.deletedAt))
    .orderBy(asc(tasks.id))
    .all()
    .map((r) => toDto({ ...r.t, newComment: r.newComment }));
}

/** Soft-deleted tasks deleted at or after `since`. */
export function listDeletedTaskDtos(db: Db | Tx, since: string): TaskDto[] {
  return select(db)
    .where(and(isNotNull(tasks.deletedAt), gte(tasks.deletedAt, since)))
    .orderBy(asc(tasks.id))
    .all()
    .map((r) => toDto({ ...r.t, newComment: r.newComment }));
}

// Read by the poller every 1.5 s, so the statement is prepared once per connection.
const due = new WeakMap<object, Statement<[string], { id: number }>>();

/** Paused tasks whose resume time has passed. */
export function listDueResumes(db: Db, now: string): number[] {
  let stmt = due.get(db.$client);
  if (!stmt) {
    stmt = db.$client.prepare(
      "SELECT id FROM tasks WHERE status = 'paused_quota' AND deleted_at IS NULL AND resume_at IS NOT NULL AND resume_at <= ? ORDER BY id",
    );
    due.set(db.$client, stmt);
  }
  return stmt.all(now).map((r) => r.id);
}
