import type { RunOutcome } from '@jiraffe/adapters';

export type EndReason = 'completed' | 'crashed' | 'cancelled';

/**
 * Maps what a process did to a run end reason.
 * shortcut: no quota or credit-limit detection yet (spec section 12 item 3 is open,
 * `quota_error_patterns` is empty by default); both are handled in the quota step.
 */
export function classify(o: RunOutcome, aborted: boolean): EndReason {
  if (aborted || o.cancelled) return 'cancelled';
  if (o.timedOut || o.spawnError !== undefined) return 'crashed';
  return o.exitCode === 0 ? 'completed' : 'crashed';
}

/** A short readable reason for Show error. The output tail is added by the caller. */
export function failureText(o: RunOutcome, timeoutMinutes: number): string {
  if (o.spawnError !== undefined) return o.spawnError;
  if (o.timedOut) return `The run timed out after ${timeoutMinutes} minutes`;
  if (o.signal) return `The agent was stopped by signal ${o.signal}`;
  return `The agent exited with code ${o.exitCode}`;
}
