import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, disposeAll, issue, makeEngine, newTaskIn, rawTask } from './helpers.ts';

const MIN = 60_000;
const calls = (jira: FakeJiraClient, method: string) =>
  jira.calls.filter((c) => c.method === method).length;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00.000Z') });
});
afterEach(() => {
  disposeAll();
  vi.useRealTimers();
});

function setup(configured = true) {
  const jira = new FakeJiraClient();
  const h = makeEngine({ jiraClient: jira, version: '9.9.9' });
  if (configured) h.engine.updateSetting('jira_base_url', BASE_URL);
  return { jira, h };
}

describe('start sequence (AC-42)', () => {
  it('journals app_started, syncs and runs retention without changing any task status', async () => {
    const { jira, h } = setup();
    const a = newTaskIn(h.engine, 'new');
    const b = newTaskIn(h.engine, 'queued_analysis');
    const old = rawTask(h.raw, { localKey: 'LOC-0900', deletedAt: '2026-01-01T00:00:00.000Z' });
    jira.setIssues([issue(1)]);
    expect(h.engine.getSetting('auto_analysis')).toBe(false);
    await h.engine.start();
    expect(h.engine.listJournal({ action: 'app_started' })).toEqual([
      expect.objectContaining({ detail: '9.9.9', taskKey: null, status: null }),
    ]);
    expect(calls(jira, 'searchPage')).toBe(1);
    expect(h.raw.prepare('SELECT 1 FROM tasks WHERE id = ?').get(old)).toBeUndefined();
    expect(h.engine.getTask(a).status).toBe('new');
    expect(h.engine.getTask(b).status).toBe('queued_analysis');
    expect(
      h.raw.prepare("SELECT count(*) c FROM events WHERE type = 'analysis_started'").get(),
    ).toEqual({ c: 0 });
    h.engine.stop();
  });

  it('still starts when Jira is down', async () => {
    const { jira, h } = setup();
    jira.failNext(new Error('down'));
    await expect(h.engine.start()).resolves.toBeUndefined();
    expect(h.engine.syncState().state).toBe('error');
    expect(h.engine.listJournal({ action: 'app_started' })).toHaveLength(1);
    h.engine.stop();
  });

  it('still starts when Jira is not configured and never calls it', async () => {
    const { jira, h } = setup(false);
    await expect(h.engine.start()).resolves.toBeUndefined();
    expect(jira.calls).toEqual([]);
    expect(h.engine.syncState().state).toBe('not_configured');
    h.engine.stop();
  });
});

import { clampDelay } from '../src/scheduler.ts';

describe('timer delay limits', () => {
  it('clamps a delay to the largest value setTimeout accepts', () => {
    expect(clampDelay(10 ** 13)).toBe(2 ** 31 - 1);
    expect(clampDelay(30 * MIN)).toBe(30 * MIN);
  });

  it.each(['99999999999', '0', '-5', '"x"'])(
    'a stored out-of-range interval (%s) falls back to the default, not a tight loop',
    async (stored) => {
      const { jira, h } = setup();
      await h.engine.start();
      h.raw
        .prepare("UPDATE settings SET value_json = ? WHERE key = 'jira_tasks_sync_minutes'")
        .run(stored);
      await vi.advanceTimersByTimeAsync(30 * MIN); // armed with the old value; re-arms after reading the bad one
      expect(calls(jira, 'searchPage')).toBe(2);
      await vi.advanceTimersByTimeAsync(29 * MIN);
      expect(calls(jira, 'searchPage')).toBe(2);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(calls(jira, 'searchPage')).toBe(3);
      h.engine.stop();
    },
  );
});

describe('timers (AC-45, AC-59)', () => {
  it('runs both syncs after 30 minutes', async () => {
    const { jira, h } = setup();
    rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    await h.engine.start();
    expect([calls(jira, 'searchPage'), calls(jira, 'getComments')]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect([calls(jira, 'searchPage'), calls(jira, 'getComments')]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect([calls(jira, 'searchPage'), calls(jira, 'getComments')]).toEqual([2, 1]);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect([calls(jira, 'searchPage'), calls(jira, 'getComments')]).toEqual([3, 2]);
    h.engine.stop();
  });

  it('applies a changed interval from the next schedule', async () => {
    const { jira, h } = setup();
    await h.engine.start();
    h.engine.updateSetting('jira_tasks_sync_minutes', 10);
    await vi.advanceTimersByTimeAsync(30 * MIN); // already armed with 30
    expect(calls(jira, 'searchPage')).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls(jira, 'searchPage')).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls(jira, 'searchPage')).toBe(4);
    h.engine.stop();
  });

  it('runs retention at start and again after 24 hours', async () => {
    const { h } = setup(false);
    await h.engine.start();
    const id = rawTask(h.raw, { localKey: 'LOC-0900', deletedAt: '2020-01-01T00:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(23 * 60 * MIN);
    expect(h.raw.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.raw.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)).toBeUndefined();
    h.engine.stop();
  });

  it('keeps firing after a failed sync', async () => {
    const { jira, h } = setup();
    jira.failNext(new Error('down'));
    await h.engine.start();
    jira.setIssues([issue(1)]);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(h.engine.syncState().state).toBe('idle');
    expect(h.raw.prepare('SELECT count(*) c FROM tasks').get()).toEqual({ c: 1 });
    h.engine.stop();
  });

  it('stop cancels the timers', async () => {
    const { jira, h } = setup();
    await h.engine.start();
    h.engine.stop();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(calls(jira, 'searchPage')).toBe(1);
  });
});
