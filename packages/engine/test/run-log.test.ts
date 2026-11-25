import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLog } from '../src/runLog.ts';
import { disposeAll, eventRows, makeEngine, queuedTask } from './helpers.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  disposeAll();
  vi.useRealTimers();
  delete process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_EMAIL;
});

function setup(cap?: number) {
  const h = makeEngine();
  const id = queuedTask(h.engine);
  const log = new RunLog(h.engine.ctx, id, 7, cap);
  return { h, id, log };
}
const out = (text: string) => ({ stream: 'stdout' as const, text });

describe('RunLog (AC-49, AC-50, AC-83)', () => {
  it('batches lines: nothing for 250 ms, then one batch with a single log hint and no board change', () => {
    const { h, id, log } = setup();
    let changed = 0;
    const logged: number[] = [];
    h.engine.bus.onChanged(() => changed++);
    h.engine.bus.onLog((e) => logged.push(e.taskId));
    log.push(out('one'));
    log.push({ stream: 'stderr', text: 'two' });
    log.push(out('three'));
    expect(eventRows(h, 'agent_output', id)).toEqual([]);
    vi.advanceTimersByTime(250);
    const rows = eventRows(h, 'agent_output', id);
    expect(rows.map((r) => JSON.parse(r.payload_json!))).toEqual([
      { runId: 7, stream: 'stdout', text: 'one' },
      { runId: 7, stream: 'stderr', text: 'two' },
      { runId: 7, stream: 'stdout', text: 'three' },
    ]);
    expect(rows.every((r) => r.processed_at !== null)).toBe(true);
    expect(logged).toEqual([id]);
    expect(changed).toBe(0); // a log flush must not refetch the whole board
  });

  it('flushes at 50 lines without waiting, and on close', () => {
    const { h, id, log } = setup();
    for (let i = 0; i < 50; i++) log.push(out(`l${i}`));
    expect(eventRows(h, 'agent_output', id)).toHaveLength(50);
    log.push(out('last'));
    log.close();
    expect(eventRows(h, 'agent_output', id)).toHaveLength(51);
  });

  it('stops storing at the cap, writes one log_truncated event, and keeps the tail growing', () => {
    const { h, id, log } = setup(20);
    for (const t of ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd']) log.push(out(t));
    log.close();
    expect(eventRows(h, 'agent_output', id)).toHaveLength(2);
    expect(eventRows(h, 'log_truncated', id)).toHaveLength(1);
    expect(log.stdoutTail()).toContain('dddddddddd');
    log.push(out('more'));
    log.close();
    expect(eventRows(h, 'log_truncated', id)).toHaveLength(1);
  });

  it('replaces the exact Jira credentials with [redacted] in storage and in the tail', () => {
    process.env.JIRA_API_TOKEN = 'tok-LOGMARK-123';
    process.env.JIRA_EMAIL = 'log.mark@example.test';
    const { h, id, log } = setup();
    log.push(out('token is tok-LOGMARK-123 and mail log.mark@example.test'));
    log.close();
    const stored = JSON.stringify(eventRows(h, 'agent_output', id));
    expect(stored).not.toContain('tok-LOGMARK-123');
    expect(stored).not.toContain('log.mark@example.test');
    expect(stored).toContain('[redacted]');
    expect(log.stdoutTail()).not.toContain('tok-LOGMARK-123');
  });

  it('keeps a bounded tail: the newest text, never more than 256 KiB', () => {
    const { log } = setup();
    for (let i = 0; i < 3000; i++) log.push(out(`${String(i).padStart(5, '0')}${'x'.repeat(250)}`));
    const tail = log.stdoutTail();
    expect(tail.length).toBeLessThanOrEqual(256 * 1024);
    expect(tail.length).toBeGreaterThan(200 * 1024);
    expect(tail.trimEnd().endsWith(`02999${'x'.repeat(250)}`)).toBe(true);
    expect(tail).not.toContain(`00000${'x'.repeat(250)}`);
  });

  it('keeps log text out of the journal', () => {
    const { h, log } = setup();
    log.push(out('JOURNAL_MARKER'));
    log.close();
    expect(JSON.stringify(h.engine.listJournal({ limit: 100 }))).not.toContain('JOURNAL_MARKER');
  });

  it('survives a storage failure without throwing', () => {
    const errors: unknown[] = [];
    const h = makeEngine({ logger: { info() {}, error: (m) => errors.push(m) } });
    const id = queuedTask(h.engine);
    const log = new RunLog(h.engine.ctx, id, 1);
    h.raw.exec('DROP TABLE events');
    log.push(out('x'));
    expect(() => log.close()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
