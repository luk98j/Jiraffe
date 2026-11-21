// The only file that writes tasks.status (AC-22). Exposed as @jiraffe/db/status-writer
// and imported only by engine/src/transition.ts and engine/src/createTask.ts.
import { eq } from 'drizzle-orm';
import type { Status } from '@jiraffe/core';
import type { Db, Tx } from './client.ts';
import { tasks } from './schema.ts';

export interface NewTask {
  source: 'jira' | 'local';
  jiraKey: string | null;
  localKey: string | null;
  title: string;
  body: string;
  repoPath: string | null;
  now: string;
}

/** Every task starts as `new`. */
export function insertTask(tx: Db | Tx, f: NewTask): number {
  const row = tx
    .insert(tasks)
    .values({
      source: f.source,
      jiraKey: f.jiraKey,
      localKey: f.localKey,
      title: f.title,
      body: f.body,
      repoPath: f.repoPath,
      status: 'new',
      lastSyncedAt: f.source === 'jira' ? f.now : null,
      createdAt: f.now,
      updatedAt: f.now,
    })
    .returning({ id: tasks.id })
    .get();
  return row.id;
}

export interface StatusPatch {
  status: Status;
  statusBeforePause: Status | null;
  pauseReason: string | null;
  resumeAt: string | null;
  /** Set only to clear the flag on re-analysis. */
  bodyChangedAfterAnalysis?: false;
  updatedAt: string;
}

export function applyStatusChange(tx: Db | Tx, id: number, patch: StatusPatch): void {
  tx.update(tasks).set(patch).where(eq(tasks.id, id)).run();
}
