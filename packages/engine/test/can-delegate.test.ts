import { afterEach, describe, expect, it } from 'vitest';
import { createCopilotRunner } from '@jiraffe/adapters';
import { FakeRunner, stubSpawner } from '@jiraffe/adapters/testing';
import { ConflictError, STATUSES } from '@jiraffe/core';
import { disposeAll, makeEngine, newTaskIn, statusOf } from './helpers.ts';

afterEach(disposeAll);

// Shared setup: most tests use FakeRunner, whose preflight is ok, so the allowlist can be
// "expressed". The real Copilot profile fails closed (spec section 12 item 1 is open): the
// last test proves that, so a fail-closed suite is not mistaken for a broken one.
function setup(
  opts: Parameters<typeof makeEngine>[0] = { runners: { copilot: new FakeRunner() } },
) {
  const h = makeEngine(opts);
  return { h, id: newTaskIn(h.engine, 'ready_to_delegate') };
}

describe('canDelegate (AC-35..39)', () => {
  it('is ok for a ready task and returns the permissions to display', () => {
    const { h, id } = setup();
    expect(h.engine.canDelegate(id)).toEqual({ ok: true, reason: null, permissions: [] });
  });

  it.each(STATUSES.filter((s) => s !== 'ready_to_delegate'))(
    'names the status %s in the reason (AC-35)',
    (status) => {
      const h = makeEngine({ runners: { copilot: new FakeRunner() } });
      const id = newTaskIn(h.engine, status);
      const r = h.engine.canDelegate(id);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(status);
    },
  );

  it('refuses when a message is newer than the last analysis (AC-36)', () => {
    let now = Date.parse('2026-11-23T10:00:00.000Z');
    const h = makeEngine({ runners: { copilot: new FakeRunner() }, clock: () => new Date(now) });
    const id = newTaskIn(h.engine, 'ready_to_delegate');
    now += 1000;
    h.engine.addUserMessage(id, 'one more thing');
    expect(h.engine.canDelegate(id)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/new message/i),
    });
  });

  it('refuses when the description changed in Jira, with the exact reason (AC-37)', () => {
    const { h, id } = setup();
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(id);
    expect(h.engine.canDelegate(id).reason).toBe(
      'Description changed in Jira, re-run the analysis',
    );
    expect(() => h.engine.delegate(id)).toThrow(ConflictError);
    expect(() => h.engine.delegate(id)).toThrow('Description changed in Jira, re-run the analysis');
    expect(statusOf(h, id)).toBe('ready_to_delegate');
  });

  it.each([
    ['empty', [], /empty/],
    ['git push', ['git status', 'git push'], /push/],
    ['git -C x push', ['git -C x push'], /push/],
    ['--yolo', ['--yolo'], /everything/],
    ['a blanket entry', ['*'], /blanket/],
  ])('refuses an allowlist that is %s (AC-38)', (_n, tools, reason) => {
    const { h, id } = setup();
    h.engine.updateSetting('allowed_tools', tools);
    expect(h.engine.canDelegate(id)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(reason),
    });
  });

  it('fails closed with the real Copilot profile because the allowlist flag is unverified (AC-38)', () => {
    const { h, id } = setup({ runners: { copilot: createCopilotRunner(stubSpawner()) } });
    expect(h.engine.canDelegate(id)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not confirmed.*item 1/),
    });
    expect(() => h.engine.delegate(id)).toThrow(ConflictError);
  });

  it('does not mind busy execution slots: the task goes to delegated (AC-39)', () => {
    const { h, id } = setup();
    for (let i = 0; i < 2; i++) {
      const other = newTaskIn(h.engine, 'delegated');
      h.raw
        .prepare(
          "INSERT INTO runs (task_id, kind, status, started_at) VALUES (?, 'execution', 'running', 'x')",
        )
        .run(other);
    }
    expect(h.engine.canDelegate(id).ok).toBe(true);
    h.engine.delegate(id);
    expect(statusOf(h, id)).toBe('delegated');
  });

  it('shows the permissions the analysis proposed, without applying them', () => {
    const { h, id } = setup();
    h.raw
      .prepare(
        `INSERT INTO runs (task_id, kind, end_reason, finished_at, result_json)
         VALUES (?, 'analysis', 'completed', 'x', ?)`,
      )
      .run(
        id,
        JSON.stringify({
          role: 'analyst',
          verdict: {
            verdict: 'READY',
            questions: [],
            missing: [],
            permissions: ['read: src/**'],
            summary: 's',
          },
        }),
      );
    expect(h.engine.canDelegate(id).permissions).toEqual(['read: src/**']);
    expect(h.engine.getSetting('allowed_tools')).not.toContain('read: src/**');
  });

  it('adds delegate to ready tasks in the task list only', () => {
    const { h, id } = setup();
    newTaskIn(h.engine, 'new');
    const list = h.engine.listTasks();
    expect(list.find((t) => t.id === id)?.delegate).toMatchObject({ ok: true });
    expect(list.filter((t) => t.id !== id).every((t) => t.delegate === undefined)).toBe(true);
  });
});
