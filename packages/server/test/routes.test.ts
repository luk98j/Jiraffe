import { afterEach, describe, expect, it } from 'vitest';
import { disposeAll, makeApp } from './helpers.ts';

afterEach(disposeAll);

const TASK = { title: 'Do it', description: 'Details', repoPath: '/repos/a' };
const DAY = 86_400_000;
const NOW = new Date('2026-11-21T12:00:00.000Z');

async function task(h: ReturnType<typeof makeApp>, over: object = {}) {
  const r = await h.req('POST', '/api/tasks', { ...TASK, ...over });
  expect(r.status).toBe(201);
  return r.body.task as { id: number; key: string };
}

describe('health and errors', () => {
  it('serves health with the engine version', async () => {
    const h = makeApp();
    expect(await h.req('GET', '/api/health')).toEqual({ status: 200, body: { ok: true, version: '1.2.3' } });
  });

  it('maps errors to JSON bodies without internals', async () => {
    const h = makeApp();
    const bad = await h.app.inject({ method: 'POST', url: '/api/tasks', payload: '{oops', headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
    const missing = await h.req('GET', '/api/tasks/999');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'not_found' });
    expect((await h.req('GET', '/api/tasks/abc')).status).toBe(400);
    expect((await h.req('GET', '/api/nope')).status).toBe(404);
  });
});

describe('tasks', () => {
  it('creates a local task (AC-46, AC-66) and lists it', async () => {
    const h = makeApp();
    const t = await task(h);
    expect(t.key).toBe('LOC-0001');
    const list = await h.req('GET', '/api/tasks');
    expect(list.body.tasks).toEqual([expect.objectContaining({ key: 'LOC-0001', status: 'new', hasNewComment: false })]);
  });

  it('rejects invalid input naming the field (AC-49)', async () => {
    const h = makeApp();
    for (const [over, field] of [[{ title: ' ' }, 'title'], [{ repoPath: '' }, 'repoPath'], [{ title: 5 }, 'title']] as const) {
      const r = await h.req('POST', '/api/tasks', { ...TASK, ...over });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'validation', field });
    }
    expect((await h.req('GET', '/api/tasks')).body.tasks).toEqual([]);
  });

  it('shows the task with time-ordered messages and 404 for a soft-deleted task', async () => {
    let t0 = NOW.getTime();
    const h = makeApp({ clock: () => new Date((t0 += 1000)) });
    const t = await task(h);
    await h.req('POST', `/api/tasks/${t.id}/messages`, { content: 'first' });
    await h.req('POST', `/api/tasks/${t.id}/messages`, { content: 'second' });
    const r = await h.req('GET', `/api/tasks/${t.id}`);
    expect(r.body.task.key).toBe('LOC-0001');
    expect(r.body.messages.map((m: { content: string }) => m.content)).toEqual(['first', 'second']);
    expect((await h.req('GET', '/api/tasks')).body.tasks[0].hasNewComment).toBe(true);
    await h.req('DELETE', `/api/tasks/${t.id}`);
    expect((await h.req('GET', `/api/tasks/${t.id}`)).status).toBe(404);
    expect((await h.req('GET', '/api/tasks')).body.tasks).toEqual([]);
  });
});

describe('repository and events (AC-63, AC-65)', () => {
  it('rejects enqueue without a repository, then works after PATCH', async () => {
    const h = makeApp();
    const t = await task(h);
    h.raw.prepare('UPDATE tasks SET repo_path = NULL WHERE id = ?').run(t.id);
    const no = await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'enqueue' });
    expect(no.status).toBe(409);
    expect(no.body.error).toMatchObject({ code: 'not_ready', message: 'Choose a repository first' });
    expect((await h.req('PATCH', `/api/tasks/${t.id}`, { repoPath: ' ' })).status).toBe(400);
    expect((await h.req('PATCH', `/api/tasks/${t.id}`, { repoPath: '/repos/b' })).body.task.repoPath).toBe('/repos/b');
    const ok = await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'enqueue' });
    expect(ok.status).toBe(200);
    expect(ok.body.task.status).toBe('queued_analysis');
  });

  it('accepts only the UI events', async () => {
    const h = makeApp();
    const t = await task(h);
    for (const event of ['delegate', 'analysis_started', 'quota', 'user_answered', 'bogus', 5]) {
      const r = await h.req('POST', `/api/tasks/${t.id}/events`, { event });
      expect(r.status, String(event)).toBe(400);
    }
    expect((await h.req('POST', `/api/tasks/${t.id}/events`, {})).status).toBe(400);
    expect(h.engine.getTask(t.id).status).toBe('new');
  });

  it('maps an invalid transition to 409 and cancel works', async () => {
    const h = makeApp();
    const t = await task(h);
    const r = await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'retry' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('invalid_transition');
    expect((await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'cancel' })).body.task.status).toBe('cancelled');
    expect((await h.req('POST', '/api/tasks/999/events', { event: 'cancel' })).status).toBe(404);
  });

  it('reanalyse clears body_changed_after_analysis (A17)', async () => {
    const h = makeApp();
    const t = await task(h);
    for (const e of ['enqueue', 'analysis_started', 'analysis_ready'] as const) h.engine.transition(t.id, e);
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(t.id);
    const r = await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'reanalyse' });
    expect(r.body.task).toMatchObject({ status: 'queued_analysis', bodyChangedAfterAnalysis: false });
  });
});

describe('messages (AC-68)', () => {
  it('moves a waiting_user task to queued_analysis and rejects empty content', async () => {
    const h = makeApp();
    const t = await task(h);
    for (const e of ['enqueue', 'analysis_started', 'analysis_needs_info'] as const) h.engine.transition(t.id, e);
    for (const content of ['', '   ', 5, undefined]) {
      expect((await h.req('POST', `/api/tasks/${t.id}/messages`, { content })).status).toBe(400);
    }
    const r = await h.req('POST', `/api/tasks/${t.id}/messages`, { content: ' answer ' });
    expect(r.status).toBe(201);
    expect(r.body.task.status).toBe('queued_analysis');
    expect(r.body.messages.at(-1)).toMatchObject({ content: 'answer', source: 'app', role: 'user' });
  });

  it('returns 404 for an unknown or deleted task', async () => {
    const h = makeApp();
    const t = await task(h);
    await h.req('DELETE', `/api/tasks/${t.id}`);
    expect((await h.req('POST', `/api/tasks/${t.id}/messages`, { content: 'x' })).status).toBe(404);
    expect((await h.req('POST', '/api/tasks/999/messages', { content: 'x' })).status).toBe(404);
  });
});

describe('delete, restore and the deleted list (AC-51..53, AC-70)', () => {
  it('soft-deletes, refuses running, and restores', async () => {
    const h = makeApp();
    const t = await task(h);
    expect((await h.req('DELETE', `/api/tasks/${t.id}`)).status).toBe(204);
    expect((await h.req('DELETE', `/api/tasks/${t.id}`)).status).toBe(404);
    expect((await h.req('GET', '/api/deleted')).body.tasks).toEqual([expect.objectContaining({ key: 'LOC-0001' })]);
    expect((await h.req('POST', `/api/tasks/${t.id}/restore`)).body.task.deletedAt).toBeNull();
    expect((await h.req('POST', `/api/tasks/${t.id}/restore`)).status).toBe(409);
    expect((await h.req('POST', '/api/tasks/999/restore')).status).toBe(404);
    expect((await h.req('GET', '/api/deleted')).body.tasks).toEqual([]);

    const r = await task(h);
    for (const e of ['enqueue', 'analysis_started', 'analysis_ready', 'delegate', 'execution_started'] as const) h.engine.transition(r.id, e);
    const del = await h.req('DELETE', `/api/tasks/${r.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toBe('Cancel the task first');
  });

  it('lists deleted tasks within retention_days, boundary included', async () => {
    const h = makeApp({ clock: () => NOW });
    const ids: Record<string, number> = {};
    for (const days of [27, 28, 29]) {
      const t = await task(h);
      ids[days] = t.id;
      h.raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(new Date(NOW.getTime() - days * DAY).toISOString(), t.id);
    }
    const ids2 = (await h.req('GET', '/api/deleted')).body.tasks.map((t: { id: number }) => t.id).sort();
    expect(ids2).toEqual([ids[27], ids[28]].sort());
  });
});

describe('journal (AC-71)', () => {
  it('filters with AND, orders newest first and keeps rows of purged tasks', async () => {
    const h = makeApp();
    const ins = h.raw.prepare('INSERT INTO journal (at, task_key, status, action) VALUES (?, ?, ?, ?)');
    ins.run('2026-01-01T00:00:01.000Z', 'A-1', 'new', 'task_imported');
    ins.run('2026-01-01T00:00:02.000Z', 'A-2', 'new', 'task_imported');
    ins.run('2026-01-01T00:00:03.000Z', 'A-1', 'analysing', 'status_changed');
    ins.run('2026-01-01T00:00:03.000Z', null, null, 'sync_run');
    const all = (await h.req('GET', '/api/journal')).body.entries;
    expect(all.map((e: { action: string; taskKey: string | null }) => `${e.action}:${e.taskKey}`)).toEqual([
      'sync_run:null', 'status_changed:A-1', 'task_imported:A-2', 'task_imported:A-1',
    ]);
    expect((await h.req('GET', '/api/journal?taskKey=A-1')).body.entries).toHaveLength(2);
    expect((await h.req('GET', '/api/journal?action=task_imported')).body.entries).toHaveLength(2);
    const both = (await h.req('GET', '/api/journal?taskKey=A-1&action=task_imported')).body.entries;
    expect(both).toEqual([expect.objectContaining({ action: 'task_imported', taskKey: 'A-1' })]);
    expect((await h.req('GET', '/api/journal?taskKey=none')).body.entries).toEqual([]);
    expect((await h.req('GET', '/api/journal?limit=2')).body.entries).toHaveLength(2);
    expect((await h.req('GET', '/api/journal?limit=abc')).status).toBe(400);
  });
});

describe('settings (AC-72, AC-85)', () => {
  it('returns values, read-only keys and problems', async () => {
    const h = makeApp();
    const r = await h.req('GET', '/api/settings');
    expect(r.body.values.retention_days).toBe(28);
    expect(r.body.readOnly).toEqual(['local_task_counter']);
    expect(r.body.problems).toEqual([]);
  });

  it('saves a valid value with one journal row naming only the key', async () => {
    const h = makeApp();
    const r = await h.req('PUT', '/api/settings/max_parallel_analysis', { value: 3 });
    expect(r.status).toBe(200);
    expect(r.body.values.max_parallel_analysis).toBe(3);
    expect((await h.req('GET', '/api/journal?action=settings_changed')).body.entries).toEqual([
      expect.objectContaining({ detail: 'max_parallel_analysis', taskKey: null, status: null }),
    ]);
  });

  it.each([
    ['max_parallel_analysis', 0], ['max_parallel_analysis', 'x'], ['retention_days', -1],
  ])('rejects %s = %j and writes nothing', async (key, value) => {
    const h = makeApp();
    const r = await h.req('PUT', `/api/settings/${key}`, { value });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'validation', field: key });
    expect((await h.req('GET', '/api/journal')).body.entries).toEqual([]);
    expect((await h.req('GET', '/api/settings')).body.values[key]).toBe(key === 'retention_days' ? 28 : 2);
  });

  it('rejects local_task_counter, unknown keys and a missing value', async () => {
    const h = makeApp();
    const a = await h.req('PUT', '/api/settings/local_task_counter', { value: 99 });
    expect(a.status).toBe(400);
    expect(a.body.error.message).toMatch(/read-only/);
    expect((await h.req('PUT', '/api/settings/nope', { value: 1 })).status).toBe(400);
    expect((await h.req('PUT', '/api/settings/retention_days', {})).status).toBe(400);
    expect((await h.req('GET', '/api/settings')).body.values.local_task_counter).toBe(0);
    expect((await h.req('GET', '/api/journal')).body.entries).toEqual([]);
  });
});

describe('sync (AC-43, AC-79)', () => {
  it('reports not configured, then runs a sync', async () => {
    // Inline stub: the server package may not import the jira package.
    const jira = {
      calls: 0,
      async searchPage() {
        this.calls++;
        return { issues: [{ key: 'P-1', projectKey: 'P', title: 't', description: null, statusName: 'To Do', statusCategory: 'new' as const }] };
      },
      async getIssues() { return []; },
      async getComments() { return []; },
    };
    const h = makeApp({ jiraClient: jira });
    expect((await h.req('POST', '/api/sync')).body).toEqual({ outcome: 'not_configured' });
    expect((await h.req('GET', '/api/sync')).body.state).toBe('not_configured');
    expect(jira.calls).toBe(0);
    await h.req('PUT', '/api/settings/jira_base_url', { value: 'https://x.atlassian.net' });
    expect((await h.req('POST', '/api/sync')).body.outcome).toBe('ok');
    expect((await h.req('GET', '/api/tasks')).body.tasks).toHaveLength(1);
    expect((await h.req('GET', '/api/sync')).body).toMatchObject({ state: 'idle', lastResult: '1 new, 0 updated' });
  });
});
