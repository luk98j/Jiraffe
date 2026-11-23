import { finishRun, type Tx } from '@jiraffe/db';
import { classify, resolveResumeAt, type EndReason } from './classify.ts';
import type { AgentResult } from './agentRun.ts';
import type { Ctx, Outbox } from './context.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';
import type { Claim } from './workers.ts';

/** Fixed texts: output text never reaches the task row or the journal. */
const REASON = { quota: 'Usage limit reached', credit_limit: 'Credit limit reached' } as const;

/** Classification with the configured patterns, over the redacted output tails. */
export function classifyResult(ctx: Ctx, res: AgentResult): EndReason {
  return classify(res.outcome, !!res.aborted, {
    patterns: getSetting(ctx, 'quota_error_patterns'),
    output: `${res.stderr}\n${res.stdout}`,
  });
}

/**
 * Ends the run as quota or credit_limit and pauses the task, in the caller's transaction.
 * The run is closed, so the paused task holds no slot. A credit limit during analysis has
 * no edge in spec section 4, so it uses the `quota` event and keeps `end_reason credit_limit`.
 */
export function pauseForLimit(
  ctx: Ctx,
  tx: Tx,
  outbox: Outbox,
  claim: Claim,
  reason: 'quota' | 'credit_limit',
  res: AgentResult,
): null {
  const now = ctx.clock();
  finishRun(tx, claim.runId, { endReason: reason, finishedAt: now.toISOString() });
  const event = reason === 'credit_limit' && claim.kind === 'execution' ? 'credit_limit' : 'quota';
  applyTransition(ctx, tx, outbox, claim.taskId, event, {
    pauseReason: REASON[reason],
    resumeAt: resolveResumeAt(
      now,
      getSetting(ctx, 'quota_retry_minutes'),
      res.outcome.quotaResetAt,
    ),
  });
  return null;
}
