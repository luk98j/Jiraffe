import type { RunOutcome } from '@jiraffe/adapters';

export type EndReason = 'completed' | 'crashed' | 'cancelled' | 'quota' | 'credit_limit';

/**
 * Exit codes that mean "usage limit". Empty on purpose: the real code is unknown until the
 * owner confirms it on a machine with `copilot` (spec section 12 item 3).
 */
export const QUOTA_EXIT_CODES: readonly number[] = [];

/**
 * Maps what a process did to a run end reason. In order: aborted, timeout, spawn error,
 * a confirmed credit-limit signal from the adapter, a quota pattern on a failing run,
 * the (disabled) exit-code rule, exit 0, anything else is a crash. With no patterns
 * configured nothing is ever `quota`.
 */
export function classify(
  o: RunOutcome,
  aborted: boolean,
  { patterns, output }: { patterns: readonly string[]; output: string },
): EndReason {
  if (aborted || o.cancelled) return 'cancelled';
  if (o.timedOut || o.spawnError !== undefined) return 'crashed';
  if (o.creditLimitReached) return 'credit_limit';
  if (o.exitCode !== null && o.exitCode !== 0) {
    const text = output.toLowerCase();
    if (patterns.some((p) => text.includes(p.toLowerCase()))) return 'quota';
    if (QUOTA_EXIT_CODES.includes(o.exitCode)) return 'quota';
  }
  return o.exitCode === 0 ? 'completed' : 'crashed';
}

/** A short readable reason for Show error. The output tail is added by the caller. */
export function failureText(o: RunOutcome, timeoutMinutes: number): string {
  if (o.spawnError !== undefined) return o.spawnError;
  if (o.timedOut) return `The run timed out after ${timeoutMinutes} minutes`;
  if (o.signal) return `The agent was stopped by signal ${o.signal}`;
  return `The agent exited with code ${o.exitCode}`;
}

/** The adapter's reset time when it is a valid future ISO time, else `now + quota_retry_minutes`. */
export function resolveResumeAt(now: Date, retryMinutes: number, resetAt?: string): string {
  const t = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (Number.isFinite(t) && t > now.getTime()) return new Date(t).toISOString();
  return new Date(now.getTime() + retryMinutes * 60_000).toISOString();
}
