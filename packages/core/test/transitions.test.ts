import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  STATUSES,
  TERMINAL,
  TRANSITION_EVENTS,
  resolveTransition,
  type Status,
  type TransitionEvent,
} from '../src/index.ts';

// Section 4 of the spec, written out literally (AC-10).
const ROWS: [Status, TransitionEvent, Status][] = [
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

describe('constants', () => {
  it('has 12 statuses and 16 transition events', () => {
    expect(STATUSES).toHaveLength(12);
    expect(TRANSITION_EVENTS).toHaveLength(16);
    expect([...TERMINAL].sort()).toEqual(['cancelled', 'done']);
  });
});

describe('resolveTransition (AC-10)', () => {
  it.each(ROWS)('%s + %s -> %s', (from, event, to) => {
    expect(resolveTransition(from, event, null)).toEqual({ kind: 'move', to });
  });

  const nonTerminal = STATUSES.filter((s) => !TERMINAL.includes(s));
  it.each(nonTerminal)('cancel from %s -> cancelled', (from) => {
    expect(resolveTransition(from, 'cancel', null)).toEqual({ kind: 'move', to: 'cancelled' });
  });

  it.each(['running', 'analysing'] as const)('resume returns status_before_pause (%s)', (before) => {
    expect(resolveTransition('paused_quota', 'resume', before)).toEqual({ kind: 'move', to: before });
  });
});

describe('resolveTransition no-ops and errors (A16)', () => {
  it.each([
    ['queued_analysis', 'enqueue'],
    ['failed', 'failed'],
    ['cancelled', 'cancel'],
    ['paused_quota', 'quota'],
    ['done', 'review_accepted'],
  ] as const)('%s + %s is a no-op', (from, event) => {
    expect(resolveTransition(from, event, null)).toEqual({ kind: 'noop' });
  });

  it('throws for pairs outside the table', () => {
    expect(() => resolveTransition('new', 'analysis_ready', null)).toThrow(InvalidTransitionError);
    expect(() => resolveTransition('done', 'cancel', null)).toThrow(InvalidTransitionError);
    expect(() => resolveTransition('cancelled', 'enqueue', null)).toThrow(InvalidTransitionError);
  });

  it('resume is never a no-op and throws outside paused_quota', () => {
    for (const s of STATUSES.filter((x) => x !== 'paused_quota')) {
      expect(() => resolveTransition(s, 'resume', 'running')).toThrow(InvalidTransitionError);
    }
  });

  it('resume throws when status_before_pause is missing', () => {
    expect(() => resolveTransition('paused_quota', 'resume', null)).toThrow(InvalidTransitionError);
  });

  it('throws for an unknown event or status', () => {
    expect(() => resolveTransition('new', 'bogus' as TransitionEvent, null)).toThrow();
    expect(() => resolveTransition('bogus' as Status, 'enqueue', null)).toThrow();
  });
});
