import { describe, expect, it } from 'vitest';
import type { RunOutcome } from '@jiraffe/adapters';
import { QUOTA_EXIT_CODES, classify, resolveResumeAt } from '../src/classify.ts';

const out = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 1,
  signal: null,
  timedOut: false,
  cancelled: false,
  ...over,
});
const c = (o: RunOutcome, patterns: string[] = [], output = '', aborted = false) =>
  classify(o, aborted, { patterns, output });

describe('classify (AC-63, AC-64)', () => {
  it('matches quota patterns as case-insensitive substrings on a failing run', () => {
    expect(c(out(), ['usage limit'], 'Error: You hit the USAGE LIMIT for today')).toBe('quota');
    expect(c(out(), ['rate', 'Usage Limit'], 'usage limit')).toBe('quota');
  });

  it('never returns quota with an empty pattern list, however quota-like the text is', () => {
    expect(c(out(), [], 'usage limit reached, quota exceeded, 429')).toBe('crashed');
  });

  it('needs a non-zero exit for a pattern to count', () => {
    expect(c(out({ exitCode: 0 }), ['usage limit'], 'usage limit')).toBe('completed');
  });

  it('keeps the exit-code rule disabled until it is confirmed', () => {
    expect(QUOTA_EXIT_CODES).toEqual([]);
    for (const code of [1, 2, 3, 75, 129, 255]) expect(c(out({ exitCode: code }))).toBe('crashed');
  });

  it('orders the rules: aborted, timeout, spawn error, credit limit, quota, exit code', () => {
    const all = out({ creditLimitReached: true });
    expect(c(all, ['x'], 'x', true)).toBe('cancelled');
    expect(c(out({ cancelled: true }))).toBe('cancelled');
    expect(c({ ...all, timedOut: true }, ['x'], 'x')).toBe('crashed');
    expect(c({ ...all, spawnError: 'copilot not found' })).toBe('crashed');
    expect(c(all, ['x'], 'x')).toBe('credit_limit');
    expect(c(out(), ['x'], 'x')).toBe('quota');
    expect(c(out({ exitCode: 0 }))).toBe('completed');
    expect(c(out({ exitCode: null, signal: 'SIGKILL' }))).toBe('crashed');
  });
});

describe('resolveResumeAt (AC-65)', () => {
  const now = new Date('2026-11-23T10:00:00.000Z');
  it('uses a valid future reset time from the adapter', () => {
    expect(resolveResumeAt(now, 60, '2026-11-23T12:30:00.000Z')).toBe('2026-11-23T12:30:00.000Z');
  });
  it.each([undefined, '', 'tomorrow', '2026-11-23T09:00:00.000Z', '2026-11-23T10:00:00.000Z'])(
    'falls back to now + quota_retry_minutes for %j',
    (reset) => {
      expect(resolveResumeAt(now, 90, reset)).toBe('2026-11-23T11:30:00.000Z');
    },
  );
});
