import { afterEach, describe, expect, it } from 'vitest';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, disposeAll, journalCount, makeEngine, newTaskIn, rawTask } from './helpers.ts';

afterEach(disposeAll);

const NOW = '2026-11-21T10:00:00.000Z';
const c = (id: string, body = `text ${id}`) => ({
  id,
  body,
  createdAt: '2026-11-20T09:00:00.000Z',
});
function setup() {
  const jira = new FakeJiraClient();
  const h = makeEngine({ jiraClient: jira, clock: () => new Date(NOW) });
  h.engine.updateSetting('jira_base_url', BASE_URL);
  return { jira, h };
}
const queried = (jira: FakeJiraClient) =>
  jira.calls
    .filter((x) => x.method === 'getComments')
    .map((x) => x.args[0])
    .sort();

describe('which tasks are queried (AC-38, AC-50)', () => {
  it('queries only the four statuses, never new, other statuses, local or deleted tasks', async () => {
    const { jira, h } = setup();
    for (const [key, status] of [
      ['P-1', 'new'],
      ['P-2', 'waiting_user'],
      ['P-3', 'ready_to_delegate'],
      ['P-4', 'running'],
      ['P-5', 'paused_quota'],
      ['P-6', 'queued_analysis'],
      ['P-7', 'review'],
    ] as const) {
      rawTask(h.raw, { jiraKey: key, status });
    }
    rawTask(h.raw, {
      jiraKey: 'P-8',
      status: 'waiting_user',
      deletedAt: '2026-11-01T00:00:00.000Z',
    });
    newTaskIn(h.engine, 'waiting_user'); // local task
    await h.engine.runCommentSync();
    expect(queried(jira)).toEqual(['P-2', 'P-3', 'P-4', 'P-5']);
  });

  it('does nothing when Jira is not configured', async () => {
    const jira = new FakeJiraClient();
    const h = makeEngine({ jiraClient: jira });
    rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    expect(await h.engine.runCommentSync()).toEqual({ outcome: 'not_configured' });
    expect(jira.calls).toEqual([]);
  });
});

describe('storing comments (AC-39, AC-40, AC-41)', () => {
  it('stores messages with source jira, role user and the comment id', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-4', status: 'running' });
    jira.setComments('P-4', [c('10'), c('11')]);
    await h.engine.runCommentSync();
    expect(
      h.raw
        .prepare(
          'SELECT role, source, content, jira_comment_id, created_at FROM messages WHERE task_id = ? ORDER BY id',
        )
        .all(id),
    ).toEqual([
      {
        role: 'user',
        source: 'jira',
        content: 'text 10',
        jira_comment_id: '10',
        created_at: '2026-11-20T09:00:00.000Z',
      },
      {
        role: 'user',
        source: 'jira',
        content: 'text 11',
        jira_comment_id: '11',
        created_at: '2026-11-20T09:00:00.000Z',
      },
    ]);
    expect(h.engine.getTask(id).status).toBe('running');
  });

  it('journals comment_added with source only, and one sync_run row with the count', async () => {
    const { jira, h } = setup();
    rawTask(h.raw, { jiraKey: 'P-4', status: 'running' });
    jira.setComments('P-4', [c('10', 'top secret words'), c('11')]);
    await h.engine.runCommentSync();
    const added = h.engine.listJournal({ action: 'comment_added' });
    expect(added).toHaveLength(2);
    expect(
      added.every(
        (j) => j.detail === 'source: jira' && j.taskKey === 'P-4' && j.status === 'running',
      ),
    ).toBe(true);
    expect(JSON.stringify(h.engine.listJournal({}))).not.toContain('secret');
    expect(h.engine.listJournal({ action: 'sync_run' })).toEqual([
      expect.objectContaining({ taskKey: null, status: null, detail: 'comments: 2 new' }),
    ]);
    expect(
      h.raw.prepare("SELECT count(*) c FROM events WHERE type = 'user_comment'").get(),
    ).toEqual({ c: 0 });
  });

  it('a second run adds no duplicates and no journal rows', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-4', status: 'running' });
    jira.setComments('P-4', [c('10')]);
    await h.engine.runCommentSync();
    const journal = h.engine.listJournal({}).length;
    await h.engine.runCommentSync();
    expect(h.engine.listMessages(id)).toHaveLength(1);
    expect(h.engine.listJournal({})).toHaveLength(journal);
  });

  it('adds only the new comment on a later run', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-4', status: 'running' });
    jira.setComments('P-4', [c('10')]);
    await h.engine.runCommentSync();
    jira.setComments('P-4', [c('10'), c('11')]);
    await h.engine.runCommentSync();
    expect(h.engine.listMessages(id)).toHaveLength(2);
    expect(
      h.engine
        .listJournal({ action: 'sync_run' })
        .map((j) => j.detail)
        .sort(),
    ).toEqual(['comments: 1 new', 'comments: 1 new']);
  });

  it('a waiting_user task goes to queued_analysis through user_answered', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    jira.setComments('P-2', [c('10'), c('11')]);
    await h.engine.runCommentSync();
    expect(h.engine.getTask(id).status).toBe('queued_analysis');
    expect(
      h.raw.prepare("SELECT count(*) c FROM events WHERE type = 'user_answered'").get(),
    ).toEqual({ c: 1 });
    expect(journalCount(h, 'status_changed')).toBe(1);
  });

  it('a waiting_user task with no new comments stays waiting', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    jira.setComments('P-2', []);
    await h.engine.runCommentSync();
    expect(h.engine.getTask(id).status).toBe('waiting_user');
    expect(journalCount(h, 'sync_run')).toBe(0);
  });

  it('skips a task deleted between fetch and apply', async () => {
    const { jira, h } = setup();
    const id = rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    jira.setComments('P-2', [c('10')]);
    const orig = jira.getComments.bind(jira);
    jira.getComments = async (key) => {
      const r = await orig(key);
      h.engine.deleteTask(id);
      return r;
    };
    await h.engine.runCommentSync();
    expect(h.engine.listMessages(id)).toEqual([]);
    expect(journalCount(h, 'comment_added')).toBe(0);
    expect(h.engine.getTask(id).status).toBe('waiting_user');
  });

  it('writes nothing when Jira fails', async () => {
    const { jira, h } = setup();
    rawTask(h.raw, { jiraKey: 'P-2', status: 'waiting_user' });
    rawTask(h.raw, { jiraKey: 'P-4', status: 'running' });
    jira.setComments('P-4', [c('10')]);
    jira.failNext(new Error('boom'));
    expect((await h.engine.runCommentSync()).outcome).toBe('error');
    expect(h.raw.prepare('SELECT count(*) c FROM messages').get()).toEqual({ c: 0 });
  });
});
