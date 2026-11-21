import type { Ctx } from './context.ts';
import { runRetention } from './retention.ts';
import { getSetting } from './settings.ts';
import { runCommentSync, runTaskSync } from './sync.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Chained timers: each one re-reads its interval when it re-arms, so a changed
 * setting applies from the next schedule. Timers never keep the process alive.
 */
export function createScheduler(ctx: Ctx) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running = false;

  function every(intervalMs: () => number, job: () => unknown, name: string) {
    const arm = () => {
      if (!running) return;
      const t = setTimeout(async () => {
        timers.delete(t);
        try {
          await job();
        } catch (err) {
          ctx.logger.error(`scheduled ${name} failed`, err);
        }
        arm();
      }, intervalMs());
      t.unref();
      timers.add(t);
    };
    arm();
  }

  return {
    start() {
      running = true;
      every(() => getSetting(ctx, 'jira_tasks_sync_minutes') * MINUTE_MS, () => runTaskSync(ctx), 'task sync');
      every(() => getSetting(ctx, 'jira_comments_sync_minutes') * MINUTE_MS, () => runCommentSync(ctx), 'comment sync');
      every(() => DAY_MS, () => runRetention(ctx), 'retention');
    },
    stop() {
      running = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
