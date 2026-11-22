import {
  deleteJournalBefore,
  deleteTaskRows,
  findPurgeCandidates,
  insertJournal,
  insertTombstone,
} from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { getSetting } from './settings.ts';

const DAY_MS = 86_400_000;

/** Purges old deleted and closed-in-Jira tasks, then old journal rows. Returns the number of purged tasks. */
export function runRetention(ctx: Ctx, now: Date = ctx.clock()): number {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - getSetting(ctx, 'retention_days') * DAY_MS).toISOString();
  const candidates = findPurgeCandidates(ctx.db, cutoff);
  for (const c of candidates) {
    write(ctx, (tx, outbox) => {
      insertJournal(tx, { at: nowIso, taskKey: c.key, status: c.status, action: 'task_purged' });
      if (c.jiraKey) insertTombstone(tx, c.jiraKey, nowIso);
      deleteTaskRows(tx, c.id);
      outbox.changed();
    });
  }
  const journalDays = getSetting(ctx, 'journal_retention_days');
  if (journalDays !== null) {
    write(ctx, (tx) => deleteJournalBefore(tx, new Date(now.getTime() - journalDays * DAY_MS).toISOString()));
  }
  return candidates.length;
}
