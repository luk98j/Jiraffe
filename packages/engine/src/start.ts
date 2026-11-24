import { insertJournal } from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { recoverRuns, recoverTasks, replayEvents } from './recovery.ts';
import { runRetention } from './retention.ts';
import { runTaskSync } from './sync.ts';

/** Runs one boot step. A failure is logged and never stops the next step. */
async function step(ctx: Ctx, name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.logger.error(`startup ${name} failed`, err);
  }
}

/**
 * Boot sequence: journal, mark dead runs crashed, move their tasks back, replay missed
 * events, Jira sync, retention, then the workers are released. Every step is isolated, so
 * a failing sync or retention never stops recovery or the start. No agent starts before the
 * sequence ends.
 */
export async function startEngine(ctx: Ctx): Promise<void> {
  write(ctx, (tx, outbox) => {
    insertJournal(tx, {
      at: ctx.clock().toISOString(),
      action: 'app_started',
      detail: ctx.version,
    });
    outbox.changed();
  });
  await step(ctx, 'run recovery', () => recoverRuns(ctx));
  await step(ctx, 'task recovery', () => recoverTasks(ctx));
  await step(ctx, 'event replay', () => replayEvents(ctx));
  await step(ctx, 'sync', () => runTaskSync(ctx));
  await step(ctx, 'retention', () => runRetention(ctx));
  ctx.workers.ready = true;
  ctx.workers.pump();
}
