import { and, desc, eq } from 'drizzle-orm';
import type { JournalDto } from '@jiraffe/core';
import type { Db, Tx } from './client.ts';
import { journal } from './schema.ts';

export interface JournalEntry {
  at: string;
  taskKey?: string | null;
  status?: string | null;
  action: string;
  detail?: string | null;
}

/** The only place journal rows are inserted. Callers pass keys, statuses, counts and field names, never text. */
export function insertJournal(tx: Db | Tx, e: JournalEntry): void {
  tx.insert(journal)
    .values({
      at: e.at,
      taskKey: e.taskKey ?? null,
      status: e.status ?? null,
      action: e.action,
      detail: e.detail ?? null,
    })
    .run();
}

export function listJournal(
  db: Db | Tx,
  f: { taskKey?: string; action?: string; limit?: number } = {},
): JournalDto[] {
  const conds = [];
  if (f.taskKey) conds.push(eq(journal.taskKey, f.taskKey));
  if (f.action) conds.push(eq(journal.action, f.action));
  return db
    .select()
    .from(journal)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(journal.at), desc(journal.id))
    .limit(Math.min(Math.max(f.limit ?? 200, 1), 1000))
    .all();
}
