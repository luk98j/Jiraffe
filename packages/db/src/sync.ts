import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { ignoredJiraKeys, messages, runs, tasks } from './schema.ts';

export interface JiraTaskRow {
  id: number;
  jiraKey: string;
  title: string;
  body: string;
  status: string;
  deletedAt: string | null;
  jiraClosed: boolean;
}

/** All Jira tasks, soft-deleted ones included. */
export function listJiraTasks(db: Db | Tx): JiraTaskRow[] {
  return db
    .select({
      id: tasks.id,
      jiraKey: tasks.jiraKey,
      title: tasks.title,
      body: tasks.body,
      status: tasks.status,
      deletedAt: tasks.deletedAt,
      jiraClosed: tasks.jiraClosed,
    })
    .from(tasks)
    .where(eq(tasks.source, 'jira'))
    .all() as JiraTaskRow[];
}

export function listIgnoredJiraKeys(db: Db | Tx): Set<string> {
  return new Set(db.select({ k: ignoredJiraKeys.jiraKey }).from(ignoredJiraKeys).all().map((r) => r.k));
}

// shortcut: "finished analysis" is any analysis run with finished_at set (runs.status is not defined by the spec); revisit when workers exist.
export function hasFinishedAnalysis(db: Db | Tx, taskId: number): boolean {
  return !!db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.kind, 'analysis'), isNotNull(runs.finishedAt)))
    .get();
}

/** Never touches status. The flag is only ever raised here; re-analysis clears it in the engine. */
export function updateTaskFields(
  tx: Db | Tx,
  id: number,
  f: { title?: string; body?: string; flagBodyChanged?: boolean; now: string },
): void {
  tx.update(tasks)
    .set({
      ...(f.title !== undefined ? { title: f.title } : {}),
      ...(f.body !== undefined ? { body: f.body } : {}),
      ...(f.flagBodyChanged ? { bodyChangedAfterAnalysis: true } : {}),
      lastSyncedAt: f.now,
      updatedAt: f.now,
    })
    .where(eq(tasks.id, id))
    .run();
}

export function markClosedInJira(tx: Db | Tx, id: number, now: string): void {
  tx.update(tasks).set({ jiraClosed: true, closedInJiraAt: now, updatedAt: now }).where(eq(tasks.id, id)).run();
}

const COMMENT_STATUSES = ['waiting_user', 'ready_to_delegate', 'running', 'paused_quota'] as const;

/** Non-deleted Jira tasks whose Jira comments are worth reading. */
export function listCommentSyncTasks(db: Db | Tx): { id: number; jiraKey: string }[] {
  return db
    .select({ id: tasks.id, jiraKey: tasks.jiraKey })
    .from(tasks)
    .where(and(eq(tasks.source, 'jira'), isNull(tasks.deletedAt), inArray(tasks.status, COMMENT_STATUSES)))
    .all() as { id: number; jiraKey: string }[];
}

export function listJiraCommentIds(db: Db | Tx, taskId: number): Set<string> {
  return new Set(
    db
      .select({ c: messages.jiraCommentId })
      .from(messages)
      .where(and(eq(messages.taskId, taskId), isNotNull(messages.jiraCommentId)))
      .all()
      .map((r) => r.c as string),
  );
}
