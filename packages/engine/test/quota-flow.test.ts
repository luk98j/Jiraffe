import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner, type FakeCall, type StubScript } from '@jiraffe/adapters/testing';
import {
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

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const MIN = 60_000;
const taskRow = (h: ReturnType<typeof makeEngine>, id: number) =>
  h.raw
    .prepare(
      'SELECT status, status_before_pause b, pause_reason r, resume_at at FROM tasks WHERE id = ?',
    )
    .get(id) as { status: string; b: string | null; r: string | null; at: string | null };

function setup(
  script: StubScript | ((c: FakeCall, n: number) => StubScript),
  opts: { patterns?: string[] } = {},
) {
  const clock = { now: T0 };
  const fake = new FakeRunner(script);
  const h = makeEngine({
    runners: { copilot: fake },
    git: realGit,
    clock: () => new Date(clock.now),
  });
  const repo = useRepo(h);
  h.engine.updateSetting('quota_error_patterns', opts.patterns ?? []);
  return { clock, fake, h, repo };
}
const out = (stream: 'stdout' | 'stderr', text: string) => ({ stream, text });

describe('credit limit and quota end the run and pause the task (AC-62, 63, 66)', () => {
  it('pauses a running task on a credit limit, with fixed reason text and a default resume time', async () => {
    const { h, repo } = setup({
      creditLimit: true,
      exitCode: 1,
      lines: [out('stderr', 'SECRET_OUTPUT_TEXT credit limit')],
    });
    const id = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, id)).toEqual({
      status: 'paused_quota',
      b: 'running',
      r: 'Credit limit reached',
      at: new Date(T0 + 60 * MIN).toISOString(),
    });
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'credit_limit', status: 'finished' });
    expect(eventRows(h, 'credit_limit', id)).toHaveLength(1);
    expect(JSON.stringify(taskRow(h, id))).not.toContain('SECRET_OUTPUT_TEXT');
  });

  it('pauses an analysing task when the output matches a quota pattern', async () => {
    const { h } = setup(
      { exitCode: 1, lines: [out('stderr', 'Error: Monthly Usage LIMIT exceeded')] },
      { patterns: ['usage limit'] },
    );
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, id)).toMatchObject({
      status: 'paused_quota',
      b: 'analysing',
      r: 'Usage limit reached',
    });
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'quota' });
    expect(eventRows(h, 'quota', id)).toHaveLength(1);
  });

  it('pauses a running task on a quota pattern too', async () => {
    const { h, repo } = setup(
      { exitCode: 2, lines: [out('stdout', 'quota exhausted')] },
      { patterns: ['quota exhausted'] },
    );
    const id = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, id)).toMatchObject({ status: 'paused_quota', b: 'running' });
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'quota' });
  });

  it('turns a credit limit during analysis into a quota event and keeps end_reason credit_limit', async () => {
    const { h } = setup({ creditLimit: true, exitCode: 1 });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, id)).toMatchObject({
      status: 'paused_quota',
      b: 'analysing',
      r: 'Credit limit reached',
    });
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'credit_limit' });
    expect(eventRows(h, 'quota', id)).toHaveLength(1);
    expect(eventRows(h, 'credit_limit', id)).toHaveLength(0);
  });

  it('treats quota-like text as a crash when the pattern list is empty (default)', async () => {
    const { h } = setup({ exitCode: 1, lines: [out('stderr', 'usage limit reached, quota, 429')] });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'crashed' });
  });

  it('uses a valid future reset time from the adapter, and ignores a past one (AC-65)', async () => {
    const future = new Date(T0 + 3 * 60 * MIN).toISOString();
    const { h, repo } = setup((_c, n) => ({
      creditLimit: true,
      exitCode: 1,
      quotaResetAt: n === 1 ? future : new Date(T0 - MIN).toISOString(),
    }));
    const a = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    h.engine.updateSetting('max_parallel_execution', 1);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, a).at).toBe(future);
    const b = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    h.engine.ctx.workers.pump();
    await h.engine.idle();
    expect(taskRow(h, b).at).toBe(new Date(T0 + 60 * MIN).toISOString());
  });
});

describe('resuming (AC-67, 68, 69, 70)', () => {
  it('resumes only when resume_at has passed, then starts one fresh run within the slots', async () => {
    let n = 0;
    const { clock, fake, h } = setup((): StubScript => {
      n++;
      return n === 1
        ? { exitCode: 1, creditLimit: true }
        : say({ verdict: 'NEEDS_INFO', questions: ['q'] });
    });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('paused_quota');

    clock.now = T0 + 59 * MIN;
    h.engine.ctx.workers.tick();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('paused_quota');
    expect(fake.calls).toHaveLength(1);

    clock.now = T0 + 60 * MIN;
    h.engine.ctx.workers.tick();
    await h.engine.idle();
    expect(taskRow(h, id)).toMatchObject({ status: 'waiting_user', b: null, r: null, at: null });
    expect(fake.calls).toHaveLength(2);
    const analysisRuns = runRows(h, id).filter((r) => r.kind === 'analysis');
    expect(analysisRuns.map((r) => r.end_reason)).toEqual(['credit_limit', 'completed']);
    expect(h.raw.prepare('SELECT count(*) c FROM runs WHERE finished_at IS NULL').get()).toEqual({
      c: 0,
    });
  });

  it('resumes a paused running task into a fresh execution run, never two live runs', async () => {
    let n = 0;
    const { clock, fake, h, repo } = setup((): StubScript => {
      n++;
      return n === 1 ? { exitCode: 1, creditLimit: true } : {};
    });
    const id = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect(taskRow(h, id)).toMatchObject({ status: 'paused_quota', b: 'running' });
    clock.now = T0 + 61 * MIN;
    h.engine.ctx.workers.tick();
    h.engine.ctx.workers.tick(); // a repeated poll must not start a second run
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('review');
    expect(fake.calls).toHaveLength(2);
    expect(runRows(h, id).map((r) => r.end_reason)).toEqual(['credit_limit', 'completed']);
  });

  it('lets the user resume before resume_at and cancel a paused task', async () => {
    const { h, repo } = setup({ exitCode: 1, creditLimit: true });
    h.engine.updateSetting('max_parallel_execution', 1);
    const a = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    const b = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect([statusOf(h, a), statusOf(h, b)]).toEqual(['paused_quota', 'paused_quota']);
    h.engine.transition(a, 'cancel');
    expect(statusOf(h, a)).toBe('cancelled');
    h.engine.transition(b, 'resume');
    expect(statusOf(h, b)).toBe('running'); // back to where it was, before resume_at
    await h.engine.idle(); // a fresh run starts and hits the limit again
    expect(statusOf(h, b)).toBe('paused_quota');
  });

  it('a paused task holds no slot, so another task keeps running (AC-70)', async () => {
    const { fake, h, repo } = setup((_c, n) => (n === 1 ? { exitCode: 1, creditLimit: true } : {}));
    h.engine.updateSetting('max_parallel_execution', 1);
    const a = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await vi.waitFor(() => expect(statusOf(h, a)).toBe('paused_quota'));
    const b = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await vi.waitFor(() => expect(statusOf(h, b)).toBe('review'));
    expect(fake.calls).toHaveLength(2);
    expect(statusOf(h, a)).toBe('paused_quota');
  });
});
