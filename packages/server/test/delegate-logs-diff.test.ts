import { afterEach, describe, expect, it } from 'vitest';
import { disposeAll, makeApp } from './helpers.ts';

afterEach(disposeAll);

async function readyTask(h: ReturnType<typeof makeApp>) {
  const r = await h.req('POST', '/api/tasks', {
    title: 'T',
    description: 'D',
    repoPath: '/repos/a',
  });
  const id = r.body.task.id as number;
  h.raw.prepare("UPDATE tasks SET status = 'ready_to_delegate' WHERE id = ?").run(id);
  return id;
}

describe('delegate (AC-37, AC-38)', () => {
  it('answers 409 with the reason when the description changed', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(id);
    const r = await h.req('POST', `/api/tasks/${id}/delegate`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Description changed in Jira, re-run the analysis');
    expect((await h.req('GET', `/api/tasks/${id}`)).body.task.status).toBe('ready_to_delegate');
  });

  it('fails closed with the real Copilot adapter and says why', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    const r = await h.req('POST', `/api/tasks/${id}/delegate`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not confirmed/);
    const detail = (await h.req('GET', `/api/tasks/${id}`)).body;
    expect(detail.delegate).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not confirmed/),
    });
    expect((await h.req('GET', '/api/tasks')).body.tasks[0].delegate.ok).toBe(false);
  });

  it('answers 409 for a task that is not ready, 404 for an unknown one', async () => {
    const h = makeApp();
    const r = await h.req('POST', '/api/tasks', { title: 'T', description: '', repoPath: '/r' });
    const res = await h.req('POST', `/api/tasks/${r.body.task.id}/delegate`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('new');
    expect((await h.req('POST', '/api/tasks/999/delegate')).status).toBe(404);
  });
});

describe('logs (AC-49)', () => {
  it('pages output lines by event id and validates the query', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    const ins = h.raw.prepare(
      "INSERT INTO events (task_id, type, payload_json, processed_at, created_at) VALUES (?, ?, ?, 'x', 'c')",
    );
    for (const text of ['one', 'two', 'three'])
      ins.run(id, 'agent_output', JSON.stringify({ runId: 1, stream: 'stdout', text }));
    ins.run(id, 'log_truncated', JSON.stringify({ runId: 1 }));
    const first = (await h.req('GET', `/api/tasks/${id}/logs?limit=2`)).body;
    expect(first.lines.map((l: { text: string }) => l.text)).toEqual(['one', 'two']);
    expect(first.truncated).toBe(false);
    const next = (await h.req('GET', `/api/tasks/${id}/logs?after=${first.lines[1].id}`)).body;
    expect(next.lines.map((l: { text: string }) => l.text)).toEqual(['three']);
    expect(next.truncated).toBe(true);
    for (const bad of ['after=-1', 'after=x', 'limit=0', 'limit=501', 'limit=1.5'])
      expect((await h.req('GET', `/api/tasks/${id}/logs?${bad}`)).status, bad).toBe(400);
  });
});

describe('diff and delete (AC-55)', () => {
  it('answers 409 when the task has no worktree', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    const r = await h.req('GET', `/api/tasks/${id}/diff`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('This task has no worktree');
  });

  it('deletes with and without the removal option', async () => {
    const h = makeApp();
    const a = await readyTask(h);
    const b = await readyTask(h);
    expect((await h.req('DELETE', `/api/tasks/${a}`)).status).toBe(204);
    expect((await h.req('DELETE', `/api/tasks/${b}?removeWorktree=1`)).status).toBe(204);
    expect((await h.req('GET', '/api/deleted')).body.tasks).toHaveLength(2);
  });
});

describe('guard on the new routes (AC-84)', () => {
  it('answers 403 to a foreign Host or Origin', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    for (const [method, url] of [
      ['POST', `/api/tasks/${id}/delegate`],
      ['GET', `/api/tasks/${id}/logs`],
      ['GET', `/api/tasks/${id}/diff`],
      ['DELETE', `/api/tasks/${id}?removeWorktree=1`],
    ] as const) {
      for (const headers of [
        { host: 'evil.example' },
        { host: '127.0.0.1:4317', origin: 'http://evil.example' },
      ]) {
        const res = await h.app.inject({ method, url, headers });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect((await h.req('GET', `/api/tasks/${id}`)).body.task.deletedAt).toBeNull();
  });

  it('keeps delegate out of the generic events endpoint (AC-85)', async () => {
    const h = makeApp();
    const id = await readyTask(h);
    expect((await h.req('POST', `/api/tasks/${id}/events`, { event: 'delegate' })).status).toBe(
      400,
    );
  });
});
