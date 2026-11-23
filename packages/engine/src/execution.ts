import { finishRun, getTaskDto, listRuns } from '@jiraffe/db';
import { failRun as fail, runAgent, selectRunner } from './agentRun.ts';
import { parseResult } from './analysis.ts';
import { classify, failureText } from './classify.ts';
import { write, type Ctx } from './context.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';
import type { Claim } from './workers.ts';

/** What the agent is told about the analysis (display text only; permissions are not applied). */
function contextText(ctx: Ctx, taskId: number): string {
  return listRuns(ctx.db, taskId, 'analysis')
    .filter((r) => r.endReason === 'completed')
    .map((r) => parseResult(r.resultJson))
    .filter((r) => r.verdict)
    .map((r) => `${r.role}: ${r.verdict?.summary}`)
    .join('\n');
}

/**
 * Execution for a claimed `delegated` task (or a resumed `running` one).
 * shortcut: the agent runs in `repo_path`; the worktree step replaces this. It stays safe
 * because real adapters refuse execution until the allowlist flag is confirmed (preflight).
 */
export async function runExecution(ctx: Ctx, claim: Claim): Promise<void> {
  const task = getTaskDto(ctx.db, claim.taskId);
  const open =
    !!task && !task.deletedAt && (task.status === 'delegated' || task.status === 'running');
  if (!task || !open) {
    write(ctx, (tx, outbox) => {
      finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: ctx.clock().toISOString() });
      outbox.changed();
    });
    return;
  }

  const allowedTools = getSetting(ctx, 'allowed_tools');
  const cwd = task.repoPath?.trim() ?? '';
  const runner = selectRunner(ctx);
  const pre = !runner
    ? { ok: false as const, reason: 'No agent adapter is configured' }
    : !cwd
      ? { ok: false as const, reason: 'Repository is not set' }
      : runner.preflight('execution', { allowedTools });

  // Start the task (delegated -> running) in the same transaction as a pre-start failure,
  // so it is never visible as running (decision X1).
  write(ctx, (tx, outbox) => {
    if (task.status === 'delegated') applyTransition(ctx, tx, outbox, task.id, 'execution_started');
    if (!pre.ok) fail(ctx, tx, outbox, claim, pre.reason);
  });
  if (!pre.ok) return;

  const values: Record<string, string> = {
    task_key: task.key,
    title: task.title,
    body: task.body,
    context: contextText(ctx, task.id),
  };
  // One pass with a function replacer: task text is never re-scanned for placeholders.
  const filled = getSetting(ctx, 'execution_prompt_template').replace(
    /\{\{(\w+)\}\}/g,
    (_m, k: string) => values[k] ?? '',
  );
  const res = await runAgent(ctx, claim, { prompt: filled, cwd, allowedTools });
  if (ctx.workers.closed) return;

  write(ctx, (tx, outbox) => {
    const now = ctx.clock().toISOString();
    const t = getTaskDto(tx, claim.taskId);
    const reason = classify(res.outcome, !!res.aborted);
    if (reason === 'cancelled' || !t || t.deletedAt || t.status !== 'running') {
      finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: now });
      outbox.changed();
    } else if (reason === 'crashed') {
      fail(
        ctx,
        tx,
        outbox,
        claim,
        failureText(res.outcome, getSetting(ctx, 'run_timeout_minutes')),
        res,
      );
    } else {
      finishRun(tx, claim.runId, { endReason: 'completed', finishedAt: now });
      applyTransition(ctx, tx, outbox, claim.taskId, 'execution_done');
    }
  });
}
