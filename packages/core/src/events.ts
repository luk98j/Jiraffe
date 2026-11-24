export const TRANSITION_EVENTS = [
  'enqueue',
  'analysis_started',
  'analysis_ready',
  'analysis_needs_info',
  'quota',
  'failed',
  'user_answered',
  'reanalyse',
  'delegate',
  'execution_started',
  'execution_done',
  'credit_limit',
  'resume',
  'review_accepted',
  'retry',
  'cancel',
] as const;
export type TransitionEvent = (typeof TRANSITION_EVENTS)[number];

/** Stored in `events` but not state transitions. */
export const EXTRA_EVENT_TYPES = [
  'user_comment',
  'agent_output',
  'log_truncated',
  'run_error',
  'recovered_to_queued_analysis',
  'recovered_to_delegated',
] as const;

export type EventType = TransitionEvent | (typeof EXTRA_EVENT_TYPES)[number];
