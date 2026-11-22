import { InvalidTransitionError } from './errors.ts';
import { TRANSITION_EVENTS, type TransitionEvent } from './events.ts';
import { STATUSES, TERMINAL, type Status } from './statuses.ts';

export type Resolution = { kind: 'move'; to: Status } | { kind: 'noop' };

// Section 4 of the spec. `resume` and `cancel` are handled separately.
const FIXED: [Status, TransitionEvent, Status][] = [
  ['new', 'enqueue', 'queued_analysis'],
  ['queued_analysis', 'analysis_started', 'analysing'],
  ['analysing', 'analysis_ready', 'ready_to_delegate'],
  ['analysing', 'analysis_needs_info', 'waiting_user'],
  ['analysing', 'quota', 'paused_quota'],
  ['analysing', 'failed', 'failed'],
  ['waiting_user', 'user_answered', 'queued_analysis'],
  ['ready_to_delegate', 'reanalyse', 'queued_analysis'],
  ['ready_to_delegate', 'delegate', 'delegated'],
  ['delegated', 'execution_started', 'running'],
  ['running', 'execution_done', 'review'],
  ['running', 'credit_limit', 'paused_quota'],
  ['running', 'quota', 'paused_quota'],
  ['running', 'failed', 'failed'],
  ['review', 'review_accepted', 'done'],
  ['review', 'failed', 'failed'],
  ['failed', 'retry', 'queued_analysis'],
];

const TABLE = new Map<string, Status>(FIXED.map(([from, event, to]) => [`${from}|${event}`, to]));

/** Target of each event regardless of the source status; `resume` has none. */
const FIXED_TARGET: Record<TransitionEvent, Status | null> = {
  enqueue: 'queued_analysis',
  analysis_started: 'analysing',
  analysis_ready: 'ready_to_delegate',
  analysis_needs_info: 'waiting_user',
  quota: 'paused_quota',
  failed: 'failed',
  user_answered: 'queued_analysis',
  reanalyse: 'queued_analysis',
  delegate: 'delegated',
  execution_started: 'running',
  execution_done: 'review',
  credit_limit: 'paused_quota',
  resume: null,
  review_accepted: 'done',
  retry: 'queued_analysis',
  cancel: 'cancelled',
};

/** Pure state machine step. Throws on any pair that is neither allowed nor an idempotent repeat. */
export function resolveTransition(
  from: Status,
  event: TransitionEvent,
  statusBeforePause: Status | null,
): Resolution {
  if (!STATUSES.includes(from)) throw new InvalidTransitionError(`Unknown status "${from}"`);
  if (!TRANSITION_EVENTS.includes(event))
    throw new InvalidTransitionError(`Unknown event "${event}"`);

  if (event === 'resume') {
    if (from === 'paused_quota' && statusBeforePause)
      return { kind: 'move', to: statusBeforePause };
  } else if (event === 'cancel') {
    if (!TERMINAL.includes(from)) return { kind: 'move', to: 'cancelled' };
  } else {
    const to = TABLE.get(`${from}|${event}`);
    if (to) return { kind: 'move', to };
  }
  if (FIXED_TARGET[event] === from) return { kind: 'noop' };
  throw new InvalidTransitionError(`Cannot apply "${event}" to a task in status "${from}"`);
}
