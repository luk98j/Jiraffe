import { and, eq, isNotNull, lt, ne, or } from 'drizzle-orm';
import type { Status } from '@jiraffe/core';
import type { Db, Tx } from './client.ts';
import { events, ignoredJiraKeys, journal, messages, runs, tasks } from './schema.ts';

export interface PurgeCandidate {
  id: number;
  key: string;
  jiraKey: string | null;
  status: Status;
}

/** Deleted before the cutoff, or closed in Jira before it (never while running). Strictly older than the cutoff. */
export function findPurgeCandidates(db: Db | Tx, cutoff: string): PurgeCandidate[] {
  return db
    .select({ id: tasks.id, jiraKey: tasks.jiraKey, localKey: tasks.localKey, status: tasks.status })
    .from(tasks)
    .where(
      or(
        and(isNotNull(tasks.deletedAt), lt(tasks.deletedAt, cutoff)),
        and(eq(tasks.source, 'jira'), isNotNull(tasks.closedInJiraAt), lt(tasks.closedInJiraAt, cutoff), ne(tasks.status, 'running')),
      ),
    )
    .all()
    .map((r) => ({ id: r.id, key: (r.jiraKey ?? r.localKey) as string, jiraKey: r.jiraKey, status: r.status }));
}

export function insertTombstone(tx: Db | Tx, jiraKey: string, at: string): void {
  tx.insert(ignoredJiraKeys).values({ jiraKey, deletedAt: at }).onConflictDoNothing().run();
}

/** Deletes the task and its messages, runs and events. Journal rows stay. */
export function deleteTaskRows(tx: Db | Tx, id: number): void {
  tx.delete(messages).where(eq(messages.taskId, id)).run();
  tx.delete(runs).where(eq(runs.taskId, id)).run();
  tx.delete(events).where(eq(events.taskId, id)).run();
  tx.delete(tasks).where(eq(tasks.id, id)).run();
}

/** The one allowed delete of journal rows (journal_retention_days). */
export function deleteJournalBefore(tx: Db | Tx, cutoff: string): void {
  tx.delete(journal).where(lt(journal.at, cutoff)).run();
}
