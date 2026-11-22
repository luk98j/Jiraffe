import { afterEach, describe, expect, it } from 'vitest';
import { JiraError, createHttpJiraClient } from '@jiraffe/jira';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, disposeAll, issue, makeEngine, taskCount } from './helpers.ts';

afterEach(disposeAll);

const TOKEN = 'tok-SECRET-9876';
const EMAIL = 'owner@example.com';
const snapshot = (h: ReturnType<typeof makeEngine>) =>
  ['tasks', 'journal', 'events', 'messages', 'settings', 'ignored_jira_keys'].map((t) => h.raw.prepare(`SELECT * FROM ${t}`).all());

describe('failed syncs (AC-44)', () => {
  it.each([
    ['HTTP 401', () => new Response('x', { status: 401 })],
    ['HTTP 429', () => new Response('x', { status: 429 })],
    ['HTTP 500', () => new Response('x', { status: 500 })],
    ['network error', () => { throw new Error(`socket hang up ${TOKEN} ${EMAIL}`); }],
  ])('%s leaves no writes, shows a safe error and the next sync succeeds', async (_name, respond) => {
    let failing = true;
    const good = new FakeJiraClient();
    good.setIssues([issue(1)]);
    const real = createHttpJiraClient({
      baseUrl: BASE_URL, email: EMAIL, token: TOKEN,
      fetch: (async () => { if (failing) return respond(); throw new Error('unused'); }) as unknown as typeof fetch,
    });
    const h = makeEngine({ jiraClient: { searchPage: (j, c) => (failing ? real.searchPage(j, c) : good.searchPage(j, c)), getIssues: (k) => good.getIssues(k), getComments: (k) => good.getComments(k) } });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    const before = snapshot(h);
    const res = await h.engine.runTaskSync();
    expect(res.outcome).toBe('error');
    expect(snapshot(h)).toEqual(before);
    const state = h.engine.syncState();
    expect(state.state).toBe('error');
    expect(state.lastError).toBeTruthy();
    for (const secret of [TOKEN, EMAIL, 'example.atlassian.net']) expect(JSON.stringify(state)).not.toContain(secret);
    expect(h.engine.listJournal({ action: 'sync_run' })).toEqual([]);

    failing = false;
    expect((await h.engine.runTaskSync()).outcome).toBe('ok');
    expect(h.engine.syncState()).toMatchObject({ state: 'idle', lastError: null });
    expect(taskCount(h)).toBe(1);
  });

  it('never exposes a raw non-Jira error message', async () => {
    const jira = new FakeJiraClient();
    jira.failNext(new Error(`boom ${TOKEN}`));
    const h = makeEngine({ jiraClient: jira });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    await h.engine.runTaskSync();
    expect(h.engine.syncState().lastError).not.toContain(TOKEN);
  });

  it('writes nothing when a later fetch step fails after new issues were found', async () => {
    const jira = new FakeJiraClient();
    const h = makeEngine({ jiraClient: jira });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    jira.setIssues([issue(1)]);
    await h.engine.runTaskSync();
    // PROJ-1 is no longer returned, so the sync looks it up by key; that lookup fails.
    jira.setIssues([issue(9)]);
    const orig = jira.getIssues.bind(jira);
    jira.getIssues = async () => { throw new JiraError('server', 'Jira returned an error (HTTP 500)'); };
    const before = snapshot(h);
    expect((await h.engine.runTaskSync()).outcome).toBe('error');
    expect(snapshot(h)).toEqual(before);
    jira.getIssues = orig;
  });
});

describe('overlapping syncs (AC-79)', () => {
  it('skips a second trigger while one is in flight', async () => {
    const jira = new FakeJiraClient();
    jira.setIssues([issue(1), issue(2)]);
    const h = makeEngine({ jiraClient: jira, clock: () => new Date('2026-11-21T10:00:00.000Z') });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    jira.block();
    const first = h.engine.runTaskSync();
    await Promise.resolve();
    const journal = h.engine.listJournal({}).length;
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'skipped' });
    expect(h.engine.syncState()).toMatchObject({ state: 'running', lastSkippedAt: '2026-11-21T10:00:00.000Z' });
    expect(h.engine.listJournal({})).toHaveLength(journal);
    expect(jira.calls.filter((c) => c.method === 'searchPage')).toHaveLength(1);
    jira.release();
    expect((await first).outcome).toBe('ok');
    expect(taskCount(h)).toBe(2);
    expect(h.engine.listJournal({ action: 'task_imported' })).toHaveLength(2);
    expect(h.engine.syncState().state).toBe('idle');
  });
});
