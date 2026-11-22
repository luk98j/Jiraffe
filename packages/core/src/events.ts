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

/** `user_comment` is stored in `events` but is not a state transition. */
export type EventType = TransitionEvent | 'user_comment';
