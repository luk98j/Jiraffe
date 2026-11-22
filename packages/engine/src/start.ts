import { insertJournal } from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { runRetention } from './retention.ts';
import { runTaskSync } from './sync.ts';

/**
 * Boot sequence: journal, task sync, retention. Failures are logged and never
 * stop the app from starting. No agent is started and no status changes here
 * (workers arrive in a later step).
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
  try {
    await runTaskSync(ctx);
  } catch (err) {
    ctx.logger.error('startup sync failed', err);
  }
  try {
    runRetention(ctx);
  } catch (err) {
    ctx.logger.error('startup retention failed', err);
  }
}
