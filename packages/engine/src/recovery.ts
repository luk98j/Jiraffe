import {
  crashUnfinishedRuns,
  listTaskDtos,
  listUnprocessedEvents,
  markEventsProcessed,
} from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { recoverTask } from './transition.ts';

/**
 * Every run still open at boot belongs to a process that is gone: mark it crashed and clear
 * its pid. The stale pid is NOT signalled (a leftover agent from the last session may keep
 * running; accepted risk, spec assumption 12).
 */
export function recoverRuns(ctx: Ctx): number {
  return write(ctx, (tx, outbox) => {
    const n = crashUnfinishedRuns(tx, ctx.clock().toISOString());
    if (n > 0) outbox.changed();
    return n;
  });
}

/** One transaction per task: `analysing` to `queued_analysis`, `running` to `delegated`. */
export function recoverTasks(ctx: Ctx): number {
  let moved = 0;
  for (const t of listTaskDtos(ctx.db)) {
    if (t.status !== 'analysing' && t.status !== 'running') continue;
    if (write(ctx, (tx, outbox) => recoverTask(ctx, tx, outbox, t.id))) moved++;
  }
  return moved;
}

/**
 * Events are wake-up hints and the claim is state-based, so replaying means: mark what the
 * last session left unprocessed. The first pump after boot then acts on the task state, and
 * an event whose effect already holds changes nothing.
 */
export function replayEvents(ctx: Ctx): number {
  let total = 0;
  for (;;) {
    const batch = listUnprocessedEvents(ctx.db, 500);
    if (batch.length === 0) return total;
    write(ctx, (tx) =>
      markEventsProcessed(
        tx,
        batch.map((e) => e.id),
        ctx.clock().toISOString(),
      ),
    );
    total += batch.length;
  }
}
