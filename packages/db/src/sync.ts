import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { ignoredJiraKeys, runs, tasks } from './schema.ts';

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
