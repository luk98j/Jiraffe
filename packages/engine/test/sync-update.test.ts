import { afterEach, describe, expect, it } from 'vitest';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, disposeAll, issue, journalCount, makeEngine } from './helpers.ts';

afterEach(disposeAll);

let now = '2026-11-21T10:00:00.000Z';
async function imported(...issues: ReturnType<typeof issue>[]) {
  const jira = new FakeJiraClient();
  const h = makeEngine({ jiraClient: jira, clock: () => new Date(now) });
  h.engine.updateSetting('jira_base_url', BASE_URL);
  jira.setIssues(issues);
  await h.engine.runTaskSync();
  const id = (key: string) =>
    (h.raw.prepare('SELECT id FROM tasks WHERE jira_key = ?').get(key) as { id: number }).id;
  return { jira, h, id };
}
const row = (h: ReturnType<typeof makeEngine>, id: number) =>
  h.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;

describe('updating from Jira (AC-32, AC-35)', () => {
  it('updates title and body only, journals field names without contents', async () => {
    const { jira, h, id } = await imported(issue(1));
    const t = id('PROJ-1');
    h.engine.addUserMessage(t, 'chat');
    h.engine.setRepository(t, '/r');
    h.engine.transition(t, 'enqueue');
    const messages = h.raw.prepare('SELECT count(*) c FROM messages').get();
    now = '2026-11-22T10:00:00.000Z';
    jira.setIssues([issue(1, { title: 'New secret title', description: 'New secret body' })]);
    await h.engine.runTaskSync();
    expect(row(h, t)).toMatchObject({
      title: 'New secret title',
      body: 'New secret body',
      status: 'queued_analysis',
      last_synced_at: now,
    });
    expect(h.raw.prepare('SELECT count(*) c FROM messages').get()).toEqual(messages);
    const rows = h.engine.listJournal({ action: 'task_updated_from_jira' });
    expect(rows).toEqual([
      expect.objectContaining({
        taskKey: 'PROJ-1',
        status: 'queued_analysis',
        detail: 'title, body',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(h.engine.listJournal({ action: 'sync_run' })[0]!.detail).toBe(
      '0 new, 1 updated; Jira returned 1 issues',
    );
  });

  it('lists only the changed field', async () => {
    const { jira, h } = await imported(issue(1));
    jira.setIssues([issue(1, { title: 'Other' })]);
    await h.engine.runTaskSync();
    expect(h.engine.listJournal({ action: 'task_updated_from_jira' })[0]!.detail).toBe('title');
  });

  it('keeps a running task running while updating it', async () => {
    const { jira, h, id } = await imported(issue(1));
    const t = id('PROJ-1');
    h.raw.prepare("UPDATE tasks SET status = 'running', repo_path = '/r' WHERE id = ?").run(t);
    jira.setIssues([issue(1, { title: 'Changed', description: 'Changed body' })]);
    await h.engine.runTaskSync();
    expect(row(h, t)).toMatchObject({ status: 'running', title: 'Changed', body: 'Changed body' });
  });

  it('writes no journal row for an unchanged task', async () => {
    const { h } = await imported(issue(1));
    expect(journalCount(h, 'task_updated_from_jira')).toBe(0);
  });
});

describe('body_changed_after_analysis (AC-33, AC-34)', () => {
  it('sets the flag when an analysis run has finished', async () => {
    const { jira, h, id } = await imported(issue(1));
    const t = id('PROJ-1');
    h.raw
      .prepare(
        "INSERT INTO runs (task_id, kind, end_reason, finished_at) VALUES (?, 'analysis', 'completed', '2026-11-21T09:00:00.000Z')",
      )
      .run(t);
    jira.setIssues([issue(1, { description: 'changed' })]);
    await h.engine.runTaskSync();
    expect(row(h, t).body_changed_after_analysis).toBe(1);
  });

  it('leaves the flag false without a finished analysis (none, or unfinished)', async () => {
    const { jira, h, id } = await imported(issue(1), issue(2));
    h.raw.prepare("INSERT INTO runs (task_id, kind) VALUES (?, 'analysis')").run(id('PROJ-2'));
    // A run that finished without completing (crashed) is not a finished analysis (AC-32b).
    h.raw
      .prepare(
        "INSERT INTO runs (task_id, kind, end_reason, finished_at) VALUES (?, 'analysis', 'crashed', 'x')",
      )
      .run(id('PROJ-1'));
    jira.setIssues([issue(1, { description: 'changed' }), issue(2, { description: 'changed' })]);
    await h.engine.runTaskSync();
    expect(row(h, id('PROJ-1')).body_changed_after_analysis).toBe(0);
    expect(row(h, id('PROJ-2')).body_changed_after_analysis).toBe(0);
  });

  it('a title-only change does not set the flag', async () => {
    const { jira, h, id } = await imported(issue(1));
    h.raw
      .prepare(
        "INSERT INTO runs (task_id, kind, end_reason, finished_at) VALUES (?, 'analysis', 'completed', 'x')",
      )
      .run(id('PROJ-1'));
    jira.setIssues([issue(1, { title: 'new title' })]);
    await h.engine.runTaskSync();
    expect(row(h, id('PROJ-1')).body_changed_after_analysis).toBe(0);
  });
});

describe('closed in Jira (AC-36)', () => {
  it('flags a board task that is no longer returned and is Done in Jira', async () => {
    const { jira, h, id } = await imported(issue(1), issue(2));
    now = '2026-11-25T08:30:00.000Z';
    jira.setIssues([issue(1), issue(2, { statusCategory: 'done', statusName: 'Done' })]);
    // Real Jira stops returning the Done issue from the search; the sync then looks it up by key.
    const search = jira.searchPage.bind(jira);
    jira.searchPage = async (jql, cursor) => {
      const page = await search(jql, cursor);
      return { ...page, issues: page.issues.filter((i) => i.statusCategory !== 'done') };
    };
    await h.engine.runTaskSync();
    expect(
      jira.calls.some((c) => c.method === 'getIssues' && JSON.stringify(c.args) === '[["PROJ-2"]]'),
    ).toBe(true);
    expect(row(h, id('PROJ-2'))).toMatchObject({
      jira_closed: 1,
      closed_in_jira_at: '2026-11-25T08:30:00.000Z',
      status: 'new',
    });
    expect(row(h, id('PROJ-1')).jira_closed).toBe(0);
    expect(h.engine.listJournal({ action: 'closed_in_jira' })).toEqual([
      expect.objectContaining({ taskKey: 'PROJ-2', status: 'new' }),
    ]);
    expect(h.engine.listJournal({ action: 'sync_run' })[0]!.detail).toBe(
      '0 new, 0 updated, 1 closed; Jira returned 1 issues',
    );
  });

  it('flags a task whose status is now ignored, and does not journal it twice', async () => {
    const { jira, h, id } = await imported(issue(1));
    h.engine.updateSetting('jira_ignored_statuses', ['To Do']);
    await h.engine.runTaskSync();
    expect(row(h, id('PROJ-1')).jira_closed).toBe(1);
    await h.engine.runTaskSync();
    expect(journalCount(h, 'closed_in_jira')).toBe(1);
    expect(journalCount(h, 'sync_run')).toBe(3);
    expect(
      h.engine
        .listJournal({ action: 'sync_run' })
        .reverse()
        .map((r) => r.detail),
    ).toEqual([
      '1 new, 0 updated; Jira returned 1 issues',
      '0 new, 0 updated, 1 closed; Jira returned 1 issues',
      '0 new, 0 updated; Jira returned 1 issues',
    ]);
    void jira;
  });

  it('does not close soft-deleted tasks', async () => {
    const { jira, h, id } = await imported(issue(1));
    h.engine.deleteTask(id('PROJ-1'));
    jira.setIssues([issue(1, { statusCategory: 'done', statusName: 'Done' })]);
    await h.engine.runTaskSync();
    expect(row(h, id('PROJ-1')).jira_closed).toBe(0);
  });
});
