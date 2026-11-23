import type { AgentRunner, RunOutcome } from '@jiraffe/adapters';
import { finishRun, insertEvent, setRunPid, type Tx } from '@jiraffe/db';
import { write, type Ctx, type Outbox } from './context.ts';
import { RunLog } from './runLog.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';
import type { AbortReason, Claim, LiveRun } from './workers.ts';

/** The one place that picks an adapter: the `agent` setting, read at every run start. */
export function selectRunner(ctx: Ctx): AgentRunner | undefined {
  return ctx.runners[getSetting(ctx, 'agent')];
}

export interface AgentResult {
  outcome: RunOutcome;
  aborted: AbortReason | undefined;
  /** Redacted rolling tails of the output. */
  stdout: string;
  stderr: string;
}

const failed = (spawnError: string): RunOutcome => ({
  exitCode: null,
  signal: null,
  timedOut: false,
  cancelled: false,
  spawnError,
});

/**
 * Starts the agent and waits for it. No transaction is open here, so the process is spawned
 * only after the claim has committed. The run is registered so cancel and delete can stop it.
 */
export async function runAgent(
  ctx: Ctx,
  claim: Claim,
  input: { prompt: string; cwd: string; allowedTools?: readonly string[] },
): Promise<AgentResult> {
  const live: LiveRun = {
    taskId: claim.taskId,
    abort(reason) {
      live.reason ??= reason;
      void live.handle?.cancel();
    },
  };
  ctx.workers.live.set(claim.runId, live);
  const log = new RunLog(ctx, claim.taskId, claim.runId);
  let outcome: RunOutcome;
  try {
    const runner = selectRunner(ctx);
    if (!runner) outcome = failed('No agent adapter is configured');
    else {
      try {
        const handle = runner.start(input.prompt, input.cwd, {
          maxCredits: claim.maxCredits,
          timeoutMs: getSetting(ctx, 'run_timeout_minutes') * 60_000,
          onOutput: (l) => log.push(l),
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        });
        live.handle = handle;
        if (live.reason) void handle.cancel();
        if (handle.pid !== undefined && !ctx.workers.closed)
          write(ctx, (tx) => setRunPid(tx, claim.runId, handle.pid ?? null));
        outcome = await handle.result;
      } catch (err) {
        outcome = failed(err instanceof Error ? err.message : 'The agent could not be started');
      }
    }
  } finally {
    ctx.workers.live.delete(claim.runId);
    if (!ctx.workers.closed) log.close();
  }
  return { outcome, aborted: live.reason, stdout: log.stdoutTail(), stderr: log.stderrTail() };
}

const ERROR_TAIL = 4096;

/**
 * Ends a run as crashed, keeps the reason in `events` for Show error, and moves the task
 * to `failed`. Runs inside the caller's transaction. `res` adds the output tail.
 */
export function failRun(
  ctx: Ctx,
  tx: Tx,
  outbox: Outbox,
  claim: Claim,
  message: string,
  res?: Pick<AgentResult, 'stdout' | 'stderr'>,
): null {
  const now = ctx.clock().toISOString();
  const tail = res ? (res.stderr || res.stdout).slice(-ERROR_TAIL) : '';
  finishRun(tx, claim.runId, { endReason: 'crashed', finishedAt: now });
  insertEvent(tx, {
    taskId: claim.taskId,
    type: 'run_error',
    payload: { runId: claim.runId, message, ...(tail ? { tail } : {}) },
    createdAt: now,
  });
  applyTransition(ctx, tx, outbox, claim.taskId, 'failed');
  return null;
}
