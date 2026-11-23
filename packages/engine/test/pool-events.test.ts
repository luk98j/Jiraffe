import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopilotRunner } from '@jiraffe/adapters';
import { FakeRunner, stubSpawner } from '@jiraffe/adapters/testing';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import {
  BASE_URL,
  deferred,
  disposeAll,
  eventRows,
  issue,
  makeEngine,
  newTaskIn,
  queuedTask,
  runRows,
  say,
  statusOf,
} from './helpers.ts';

afterEach(() => {
  disposeAll();
  vi.useRealTimers();
});

const needsInfo = say({ verdict: 'NEEDS_INFO', questions: ['q'] });

describe('boot gating (AC-8, AC-9, AC-10)', () => {
  it('starts nothing with auto_analysis off (AC-8)', async () => {
    const fake = new FakeRunner(needsInfo);
    const h = makeEngine({ runners: { copilot: fake } });
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(fake.calls).toEqual([]);
    expect(runRows(h)).toEqual([]);
    expect(statusOf(h, id)).toBe('queued_analysis');
  });

  it('starts queued tasks only after the boot sequence finished (AC-9)', async () => {
    const jira = new FakeJiraClient();
    jira.setIssues([issue(1)]);
    const fake = new FakeRunner(needsInfo);
    const h = makeEngine({ runners: { copilot: fake }, jiraClient: jira });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    h.engine.updateSetting('auto_analysis', true);
    queuedTask(h.engine);
    let syncedAtFirstStart = -1;
    fake.onStart = () => {
      syncedAtFirstStart = jira.calls.filter((c) => c.method === 'searchPage').length;
    };
    await h.engine.start();
    await h.engine.idle();
    expect(fake.calls).toHaveLength(1);
    expect(syncedAtFirstStart).toBe(1);
  });

  it('does not claim before the engine is ready, even with auto_analysis on', async () => {
    const fake = new FakeRunner(needsInfo);
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    queuedTask(h.engine);
    h.engine.ctx.workers.pump();
    expect(runRows(h)).toEqual([]);
  });

  it('Start queue lets workers start up to the slot limit; without it none starts (AC-10)', async () => {
    const gate = deferred();
    const fake = new FakeRunner({ ...say(), until: gate.promise });
    const h = makeEngine({ runners: { copilot: fake } });
    for (let i = 0; i < 3; i++) queuedTask(h.engine);
    await h.engine.start();
    expect(h.engine.queueState()).toMatchObject({
      started: false,
      autoAnalysis: false,
      active: { analysis: 0, execution: 0 },
      max: { analysis: 2, execution: 2 },
    });
    expect(runRows(h)).toEqual([]);

    h.engine.startQueue();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(h.engine.queueState()).toMatchObject({ started: true, active: { analysis: 2 } });
    gate.resolve();
    await h.engine.idle();
  });
});

describe('poller (AC-11)', () => {
  it('dispatches a missed event, marks it processed, and a replay starts no second run', async () => {
    const gate = deferred();
    const fake = new FakeRunner({ ...say(), until: gate.promise });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    await h.engine.start();
    // A change the in-process emitter never saw: written straight to the database.
    const id = h.engine.createLocalTask({ title: 'T', description: '', repoPath: '/r' }).id;
    h.raw.prepare("UPDATE tasks SET status = 'queued_analysis' WHERE id = ?").run(id);
    h.raw
      .prepare("INSERT INTO events (task_id, type, created_at) VALUES (?, 'enqueue', 'x')")
      .run(id);
    expect(runRows(h)).toEqual([]);

    h.engine.ctx.workers.tick();
    expect(runRows(h)).toHaveLength(1);
    expect(eventRows(h, 'enqueue', id)[0]?.processed_at).not.toBeNull();
    h.engine.ctx.workers.tick();
    h.engine.ctx.workers.pump();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(runRows(h)).toHaveLength(1);
    gate.resolve();
    await h.engine.idle();
  });

  it('runs on a 1.5 second timer driven by fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = new FakeRunner(needsInfo);
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    await h.engine.start();
    const id = h.engine.createLocalTask({ title: 'T', description: '', repoPath: '/r' }).id;
    h.raw.prepare("UPDATE tasks SET status = 'queued_analysis' WHERE id = ?").run(id);
    h.raw
      .prepare("INSERT INTO events (task_id, type, created_at) VALUES (?, 'enqueue', 'x')")
      .run(id);
    await vi.advanceTimersByTimeAsync(1400);
    expect(runRows(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(runRows(h)).toHaveLength(1);
    await h.engine.idle();
    h.engine.stop();
  });

  it('does not store agent output as unprocessed events', async () => {
    const fake = new FakeRunner(say());
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    const out = eventRows(h, 'agent_output');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.processed_at !== null)).toBe(true);
  });
});

describe('cancel, delete and failures (AC-18, AC-19, AC-20)', () => {
  it('cancelling during analysing kills the run and discards its result (AC-19)', async () => {
    const fake = new FakeRunner({ hang: true });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    h.engine.transition(id, 'cancel');
    await h.engine.idle();
    expect(fake.spawner.kills[0]?.signal).toBe('SIGTERM');
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'cancelled', status: 'finished' });
    expect(statusOf(h, id)).toBe('cancelled');
    expect(h.raw.prepare('SELECT count(*) c FROM messages').get()).toEqual({ c: 0 });
  });

  it('deleting during analysing cancels the run and keeps the task deleted (AC-19)', async () => {
    const fake = new FakeRunner({ hang: true });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    h.engine.deleteTask(id);
    await h.engine.idle();
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'cancelled' });
    expect(statusOf(h, id)).toBe('analysing');
    expect(h.engine.getTask(id).deletedAt).not.toBeNull();
  });

  it('a missing binary fails the task and keeps "copilot not found" for Show error (AC-20)', async () => {
    const spawner = stubSpawner({ error: { code: 'ENOENT', message: 'spawn copilot ENOENT' } });
    const h = makeEngine({ runners: { copilot: createCopilotRunner(spawner) } });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'crashed' });
    expect(JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!)).toMatchObject({
      message: 'copilot not found',
    });
  });

  it('a non-zero exit fails the task and keeps the output tail (AC-20)', async () => {
    const fake = new FakeRunner({
      exitCode: 2,
      lines: [{ stream: 'stderr', text: 'something broke' }],
    });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    const payload = JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!);
    expect(payload.message).toBe('The agent exited with code 2');
    expect(payload.tail).toContain('something broke');
  });

  it('kills a run that exceeds run_timeout_minutes and ends it crashed (AC-18)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = new FakeRunner({ hang: true });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    h.engine.updateSetting('run_timeout_minutes', 1);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.engine.idle();
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'crashed' });
    expect(statusOf(h, id)).toBe('failed');
    expect(JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!).message).toMatch(
      /timed out after 1 minutes/,
    );
    h.engine.stop();
  });

  it('closing the engine kills live runs and writes nothing afterwards', async () => {
    const fake = new FakeRunner({ hang: true });
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    queuedTask(h.engine);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    h.engine.ctx.workers.close();
    await h.engine.idle();
    expect(fake.spawner.kills.length).toBeGreaterThan(0);
    expect(runRows(h)[0]?.finished_at).toBeNull(); // boot recovery owns the cleanup
  });
});

describe('execution (minimal, before worktrees)', () => {
  it('fails closed with the real Copilot profile: running then failed in one transaction, no spawn', async () => {
    const spawner = stubSpawner();
    const h = makeEngine({ runners: { copilot: createCopilotRunner(spawner) } });
    const id = newTaskIn(h.engine, 'delegated');
    const seen: string[] = [];
    h.engine.bus.onChanged(() => seen.push(statusOf(h, id)));
    await h.engine.start();
    await h.engine.idle();
    expect(spawner.spawns).toEqual([]);
    expect(statusOf(h, id)).toBe('failed');
    expect(seen).not.toContain('running'); // never visible as running
    expect(runRows(h)[0]).toMatchObject({ kind: 'execution', end_reason: 'crashed' });
    const payload = JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!);
    expect(payload.message).toMatch(/not confirmed/);
    expect(eventRows(h, 'execution_started', id)).toHaveLength(1);
  });
});
