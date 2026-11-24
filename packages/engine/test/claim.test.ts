import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner } from '@jiraffe/adapters/testing';
import {
  deferred,
  disposeAll,
  eventRows,
  makeEngine,
  newTaskIn,
  queuedTask,
  runRows,
  say,
  statusOf,
  useRepo,
} from './helpers.ts';

afterEach(disposeAll);

const waitCalls = (f: FakeRunner, n: number) => vi.waitFor(() => expect(f.calls.length).toBe(n));

describe('slots (AC-1, AC-2, AC-7)', () => {
  it('runs at most max_parallel_analysis analyses and leaves the rest queued (AC-1)', async () => {
    const gate = deferred();
    const fake = new FakeRunner({ ...say(), until: gate.promise });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const ids = [queuedTask(h.engine), queuedTask(h.engine), queuedTask(h.engine)];
    await h.engine.start();

    expect(ids.map((i) => statusOf(h, i))).toEqual(['analysing', 'analysing', 'queued_analysis']);
    expect(runRows(h).filter((r) => r.finished_at === null)).toHaveLength(2);
    await waitCalls(fake, 2);
    gate.resolve();
    await h.engine.idle();
  });

  it('uses a freed slot at once, without waiting for the poller (AC-2, AC-7)', async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const fake = new FakeRunner((_c, n) => ({
      ...say({ verdict: 'NEEDS_INFO', questions: ['Which API?'] }),
      until: gates[n - 1]!.promise,
    }));
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const ids = [queuedTask(h.engine), queuedTask(h.engine), queuedTask(h.engine)];
    await h.engine.start();
    await waitCalls(fake, 2);

    gates[0]!.resolve(); // the first analysis ends with NEEDS_INFO: its slot is released
    await waitCalls(fake, 3);
    expect(statusOf(h, ids[0]!)).toBe('waiting_user');
    expect(statusOf(h, ids[2]!)).toBe('analysing');
    for (const g of gates) g.resolve();
    await h.engine.idle();
  });

  it('limits execution to max_parallel_execution (AC-3)', async () => {
    let live = 0;
    let max = 0;
    const gates = [deferred(), deferred(), deferred()];
    const fake = new FakeRunner((_c, n) => {
      live++;
      max = Math.max(max, live);
      void gates[n - 1]!.promise.then(() => live--);
      return { until: gates[n - 1]!.promise };
    });
    const h = makeEngine({ runners: { copilot: fake }, git: realGit });
    const repo = useRepo(h);
    const ids = [1, 2, 3].map(() => newTaskIn(h.engine, 'delegated', 'analysing', repo.path));
    await h.engine.start();

    await vi.waitFor(() =>
      expect(ids.map((i) => statusOf(h, i))).toEqual(['running', 'running', 'delegated']),
    );
    gates[0]!.resolve();
    await waitCalls(fake, 3);
    expect(ids.filter((i) => statusOf(h, i) === 'review')).toHaveLength(1);
    for (const g of gates) g.resolve();
    await h.engine.idle();
    expect(max).toBe(2);
    expect(ids.map((i) => statusOf(h, i))).toEqual(['review', 'review', 'review']);
  });
});

describe('claiming (AC-4, AC-5, AC-6, AC-12)', () => {
  it('claims each task exactly once with two engines on one database (AC-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiraffe-claim-'));
    try {
      const gate = deferred();
      const fakes = [0, 1].map(() => new FakeRunner({ ...say(), until: gate.promise }));
      const a = makeEngine({ runners: { copilot: fakes[0]! } }, dir);
      const b = makeEngine({ runners: { copilot: fakes[1]! } }, dir);
      a.engine.updateSetting('auto_analysis', true);
      a.engine.updateSetting('max_parallel_analysis', 10);
      const ids = Array.from({ length: 10 }, () => queuedTask(a.engine));
      await Promise.all([a.engine.start(), b.engine.start()]);
      for (const h of [a, b, a, b]) h.engine.ctx.workers.pump();

      await vi.waitFor(() => expect(fakes[0]!.calls.length + fakes[1]!.calls.length).toBe(10));
      for (const id of ids) {
        expect(eventRows(a, 'analysis_started', id)).toHaveLength(1);
        expect(runRows(a, id)).toHaveLength(1);
        expect(statusOf(a, id)).toBe('analysing');
      }
      gate.resolve();
      await Promise.all([a.engine.idle(), b.engine.idle()]);
    } finally {
      disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows priority, then updated_at (AC-5)', async () => {
    const order: string[] = [];
    const fake = new FakeRunner((c) => {
      order.push(/Title: (.*)/.exec(c.prompt)?.[1] ?? '?');
      return say({ verdict: 'NEEDS_INFO', questions: ['q'] });
    });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('max_parallel_analysis', 1);
    const mk = (title: string, priority: number, updated: string) => {
      const id = queuedTask(h.engine, title);
      h.raw
        .prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')
        .run(priority, updated, id);
    };
    mk('late-p1', 1, '2026-02-03T00:00:00.000Z');
    mk('p5', 5, '2026-02-01T00:00:00.000Z');
    mk('early-p1', 1, '2026-02-01T00:00:00.000Z');
    mk('p0', 0, '2026-02-09T00:00:00.000Z');
    h.engine.updateSetting('auto_analysis', true);
    await h.engine.start();
    await h.engine.idle();
    expect(order).toEqual(['p0', 'early-p1', 'late-p1', 'p5']);
  });

  it('never claims a soft-deleted task (AC-6)', async () => {
    const fake = new FakeRunner(say({ verdict: 'NEEDS_INFO', questions: ['q'] }));
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const gone = queuedTask(h.engine, 'gone');
    const kept = queuedTask(h.engine, 'kept');
    h.engine.deleteTask(gone);
    await h.engine.start();
    await h.engine.idle();
    expect(fake.calls).toHaveLength(1);
    expect(statusOf(h, gone)).toBe('queued_analysis');
    expect(statusOf(h, kept)).toBe('waiting_user');
  });

  it('spawns only after the claim committed, and commits the run result before the status change (AC-12)', async () => {
    const fake = new FakeRunner(say());
    const h = makeEngine({ runners: { copilot: fake } });
    const inTx: boolean[] = [];
    fake.onStart = () => inTx.push(h.engine.ctx.db.$client.inTransaction);
    const seen: { finished: boolean; result: boolean }[] = [];
    h.engine.bus.onEvent((e) => {
      if (e.type !== 'analysis_ready') return;
      // Subscribers only see committed changes: the run rows must already be final.
      const rows = runRows(h);
      seen.push({
        finished: rows.every((r) => r.finished_at !== null),
        result: rows.every((r) => r.result_json?.includes('verdict')),
      });
    });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('ready_to_delegate');
    expect(inTx).toEqual([false, false]);
    expect(seen).toEqual([{ finished: true, result: true }]);
  });
});
