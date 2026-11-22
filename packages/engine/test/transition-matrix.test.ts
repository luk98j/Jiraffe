import { afterAll, describe, expect, it } from 'vitest';
import { makeEngine, newTaskIn } from './helpers.ts';

// Independent literal copies of the spec (section 4), not imported from core (AC-11, AC-14).
const STATUSES = [
  'new',
  'queued_analysis',
  'analysing',
  'waiting_user',
  'ready_to_delegate',
  'delegated',
  'running',
  'paused_quota',
  'review',
  'done',
  'failed',
  'cancelled',
];
const EVENTS = [
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
];
const TABLE: Record<string, string> = {
  'new|enqueue': 'queued_analysis',
  'queued_analysis|analysis_started': 'analysing',
  'analysing|analysis_ready': 'ready_to_delegate',
  'analysing|analysis_needs_info': 'waiting_user',
  'analysing|quota': 'paused_quota',
  'analysing|failed': 'failed',
  'waiting_user|user_answered': 'queued_analysis',
  'ready_to_delegate|reanalyse': 'queued_analysis',
  'ready_to_delegate|delegate': 'delegated',
  'delegated|execution_started': 'running',
  'running|execution_done': 'review',
  'running|credit_limit': 'paused_quota',
  'running|quota': 'paused_quota',
  'running|failed': 'failed',
  'paused_quota|resume': 'analysing', // the fixture pauses from `analysing`
  'review|review_accepted': 'done',
  'review|failed': 'failed',
  'failed|retry': 'queued_analysis',
};
for (const s of STATUSES) if (s !== 'done' && s !== 'cancelled') TABLE[`${s}|cancel`] = 'cancelled';
const FIXED_TARGET: Record<string, string | null> = {
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

type Outcome = { kind: 'move'; to: string } | { kind: 'noop' } | { kind: 'throw' };
function expected(status: string, event: string): Outcome {
  const to = TABLE[`${status}|${event}`];
  if (to) return { kind: 'move', to };
  if (FIXED_TARGET[event] === status) return { kind: 'noop' };
  return { kind: 'throw' };
}

describe('transition() over every (status, event) pair (AC-11, AC-14)', () => {
  const h = makeEngine();
  afterAll(() => h.dispose());
  const snapshot = (id: number) => ({
    task: h.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
    events: h.raw.prepare('SELECT * FROM events').all(),
    journal: h.raw.prepare('SELECT * FROM journal').all(),
  });

  it('covers 12 x 16 = 192 pairs', () => {
    expect(STATUSES.length * EVENTS.length).toBe(192);
  });

  const cases = STATUSES.flatMap((s) => EVENTS.map((e) => [s, e] as const));
  it.each(cases)('%s + %s', (status, event) => {
    const id = newTaskIn(h.engine, status);
    const before = snapshot(id);
    const want = expected(status, event);
    if (want.kind === 'throw') {
      expect(() => h.engine.transition(id, event as never)).toThrow();
      expect(snapshot(id)).toEqual(before);
    } else if (want.kind === 'noop') {
      expect(h.engine.transition(id, event as never)).toEqual({ changed: false, status });
      expect(snapshot(id)).toEqual(before);
    } else {
      const res = h.engine.transition(id, event as never);
      expect(res).toEqual({ changed: true, from: status, to: want.to });
      const after = snapshot(id);
      expect(h.engine.getTask(id).status).toBe(want.to);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.journal).toHaveLength(before.journal.length + 1);
    }
  });
});
