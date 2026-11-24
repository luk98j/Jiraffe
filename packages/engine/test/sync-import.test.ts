import { afterEach, describe, expect, it } from 'vitest';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, disposeAll, issue, journalCount, makeEngine, taskCount } from './helpers.ts';

afterEach(disposeAll);

const NOW = '2026-11-21T10:00:00.000Z';
function setup() {
  const jira = new FakeJiraClient();
  const h = makeEngine({ jiraClient: jira, clock: () => new Date(NOW) });
  h.engine.updateSetting('jira_base_url', BASE_URL);
  return { jira, h };
}
const syncRuns = (h: ReturnType<typeof makeEngine>) => h.engine.listJournal({ action: 'sync_run' });

describe('importing new issues (AC-24, AC-81)', () => {
  it('creates tasks with all columns, task_imported rows and one sync_run row', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1), issue(2), issue(3)]);
    expect(await h.engine.runTaskSync()).toMatchObject({ outcome: 'ok' });
    const rows = h.raw.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source: 'jira',
      status: 'new',
      jira_key: 'PROJ-1',
      local_key: null,
      title: 'Title PROJ-1',
      body: 'Body PROJ-1',
      last_synced_at: NOW,
      repo_path: null,
    });
    const imported = h.engine.listJournal({ action: 'task_imported' });
    expect(imported).toHaveLength(3);
    expect(imported.every((j) => j.status === 'new' && j.detail === 'from Jira')).toBe(true);
    expect(syncRuns(h)).toEqual([
      expect.objectContaining({
        taskKey: null,
        status: null,
        detail: '3 new, 0 updated; Jira returned 3 issues',
      }),
    ]);
  });

  it('imports 120 issues over 3 pages', async () => {
    const { jira, h } = setup();
    jira.setIssues(Array.from({ length: 120 }, (_, i) => issue(i + 1)));
    await h.engine.runTaskSync();
    expect(taskCount(h)).toBe(120);
    expect(syncRuns(h)[0]!.detail).toBe('120 new, 0 updated; Jira returned 120 issues');
  });

  it('creates one task for a duplicate key in one response (AC-82)', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1), issue(1)]);
    await h.engine.runTaskSync();
    expect(taskCount(h)).toBe(1);
    expect(journalCount(h, 'task_imported')).toBe(1);
  });

  it('handles null and empty descriptions and very long text', async () => {
    const { jira, h } = setup();
    const long = 'x'.repeat(200_000);
    jira.setIssues([
      issue(1, { description: null }),
      issue(2, { description: '' }),
      issue(3, { title: long, description: long }),
    ]);
    await h.engine.runTaskSync();
    const rows = h.raw.prepare('SELECT body, title FROM tasks ORDER BY id').all() as {
      body: string;
      title: string;
    }[];
    expect([rows[0]!.body, rows[1]!.body]).toEqual(['', '']);
    expect(rows[2]!.title).toHaveLength(200_000);
  });

  it('creates no task and writes one sync_run row for an empty result', async () => {
    const { h } = setup();
    expect(await h.engine.runTaskSync()).toMatchObject({ outcome: 'ok' });
    expect(taskCount(h)).toBe(0);
    expect(syncRuns(h)).toEqual([
      expect.objectContaining({ detail: '0 new, 0 updated; Jira returned 0 issues' }),
    ]);
  });
});

describe('filtering (AC-25, AC-26, AC-31)', () => {
  it('does not create tasks for Done issues or ignored statuses', async () => {
    const { jira, h } = setup();
    h.engine.updateSetting('jira_ignored_statuses', ['Blocked']);
    jira.setIssues([
      issue(1, { statusCategory: 'done', statusName: 'Done' }),
      issue(2, { statusName: 'Blocked', statusCategory: 'indeterminate' }),
      issue(3),
    ]);
    await h.engine.runTaskSync();
    expect(
      (h.raw.prepare('SELECT jira_key FROM tasks').all() as { jira_key: string }[]).map(
        (r) => r.jira_key,
      ),
    ).toEqual(['PROJ-3']);
  });

  it('sends the JQL built from the current settings', async () => {
    const { jira, h } = setup();
    h.engine.updateSetting('jira_ignored_statuses', ['Blocked']);
    h.engine.updateSetting('jira_projects', ['PROJ']);
    await h.engine.runTaskSync();
    expect(jira.calls[0]).toEqual({
      method: 'searchPage',
      args: [
        'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Blocked") AND project IN (PROJ)',
        undefined,
      ],
    });
  });

  it('changing the ignored list later removes nothing from the board', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1), issue(2)]);
    await h.engine.runTaskSync();
    h.engine.updateSetting('jira_ignored_statuses', ['To Do']);
    await h.engine.runTaskSync();
    expect(taskCount(h)).toBe(2);
    expect(h.raw.prepare('SELECT count(*) c FROM tasks WHERE deleted_at IS NULL').get()).toEqual({
      c: 2,
    });
  });
});

describe('repeat syncs (AC-27, AC-28, AC-29, journal repeat rule)', () => {
  it('a second identical sync creates nothing and adds one sync_run row, a third adds none', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1), issue(2), issue(3)]);
    await h.engine.runTaskSync();
    const taskRows = () =>
      ['task_imported', 'task_updated_from_jira', 'closed_in_jira'].map((a) => journalCount(h, a));
    const before = taskRows();
    await h.engine.runTaskSync();
    expect(taskCount(h)).toBe(3);
    expect(taskRows()).toEqual(before);
    expect(syncRuns(h).map((r) => r.detail)).toEqual([
      '0 new, 0 updated; Jira returned 3 issues',
      '3 new, 0 updated; Jira returned 3 issues',
    ]);
    await h.engine.runTaskSync();
    expect(syncRuns(h)).toHaveLength(2);
  });

  it('does not re-import a soft-deleted board task', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1)]);
    await h.engine.runTaskSync();
    const id = (h.raw.prepare('SELECT id FROM tasks').get() as { id: number }).id;
    h.engine.deleteTask(id);
    await h.engine.runTaskSync();
    expect(taskCount(h)).toBe(1);
    expect(h.engine.getTask(id).deletedAt).not.toBeNull();
  });

  it('does not import a tombstoned key', async () => {
    const { jira, h } = setup();
    h.raw
      .prepare("INSERT INTO ignored_jira_keys (jira_key, deleted_at) VALUES ('PROJ-1', 'x')")
      .run();
    jira.setIssues([issue(1), issue(2)]);
    await h.engine.runTaskSync();
    expect(
      (h.raw.prepare('SELECT jira_key FROM tasks').all() as { jira_key: string }[]).map(
        (r) => r.jira_key,
      ),
    ).toEqual(['PROJ-2']);
  });
});

describe('repository mapping (AC-37)', () => {
  it('maps the project key to a path, or leaves it null', async () => {
    const { jira, h } = setup();
    h.engine.updateSetting('repo_map', { PROJ: '/repos/proj' });
    jira.setIssues([issue(1), issue('ABC-5')]);
    await h.engine.runTaskSync();
    const rows = h.raw.prepare('SELECT jira_key, repo_path FROM tasks ORDER BY id').all();
    expect(rows).toEqual([
      { jira_key: 'PROJ-1', repo_path: '/repos/proj' },
      { jira_key: 'ABC-5', repo_path: null },
    ]);
  });
});

describe('not configured (AC-43)', () => {
  it('never calls the client and reports not_configured', async () => {
    const jira = new FakeJiraClient();
    jira.setIssues([issue(1)]);
    const h = makeEngine({ jiraClient: jira });
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'not_configured' });
    expect(jira.calls).toEqual([]);
    expect(h.engine.syncState().state).toBe('not_configured');
    expect(taskCount(h)).toBe(0);
  });

  it('reports a readable error when credentials are missing', async () => {
    const h = makeEngine();
    h.engine.updateSetting('jira_base_url', BASE_URL);
    const res = await h.engine.runTaskSync();
    expect(res.outcome).toBe('error');
    expect(h.engine.syncState()).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('JIRA_API_TOKEN'),
    });
  });
});

describe('state', () => {
  it('records the last run and result', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1)]);
    await h.engine.runTaskSync();
    expect(h.engine.syncState()).toEqual({
      state: 'idle',
      lastRunAt: NOW,
      lastError: null,
      lastSkippedAt: null,
      lastResult: '1 new, 0 updated; Jira returned 1 issues',
    });
  });
});
