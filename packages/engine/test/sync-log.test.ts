import { afterEach, describe, expect, it } from 'vitest';
import { JiraError, buildJql } from '@jiraffe/jira';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { BASE_URL, captureLogger, disposeAll, issue, makeEngine, rawTask } from './helpers.ts';

afterEach(() => {
  disposeAll();
});

function setup(configured = true) {
  const jira = new FakeJiraClient();
  const { logger, lines } = captureLogger();
  const h = makeEngine({ jiraClient: jira, logger });
  if (configured) h.engine.updateSetting('jira_base_url', BASE_URL);
  return { jira, h, lines };
}
const texts = (lines: ReturnType<typeof captureLogger>['lines'], level: 'info' | 'error') =>
  lines.filter((l) => l.level === level).map((l) => l.text);

describe('task sync log lines', () => {
  it('logs "started" before the first Jira request (AC-1)', async () => {
    const { jira, h, lines } = setup();
    let linesAtFirstRequest = -1;
    const original = jira.searchPage.bind(jira);
    jira.searchPage = async (jql, cursor) => {
      if (linesAtFirstRequest < 0) linesAtFirstRequest = lines.length;
      return original(jql, cursor);
    };
    await h.engine.runTaskSync();
    expect(linesAtFirstRequest).toBeGreaterThan(0);
    expect(lines.slice(0, linesAtFirstRequest)).toEqual([
      { level: 'info', text: 'Jira task sync started', extra: [] },
    ]);
  });

  it('logs the counts, the returned number and the exact JQL on success (AC-2)', async () => {
    const { jira, h, lines } = setup();
    h.engine.updateSetting('jira_projects', ['PROJ']);
    h.engine.updateSetting('jira_ignored_statuses', ['Blocked']);
    jira.setIssues([issue(1), issue(2), issue(3)]);
    await h.engine.runTaskSync();
    const jql = buildJql({ ignoredStatuses: ['Blocked'], projects: ['PROJ'] });
    expect(texts(lines, 'info')).toContain(
      `Jira task sync finished: 3 new, 0 updated; Jira returned 3 issues; JQL: ${jql}`,
    );
    expect(jira.calls[0]).toMatchObject({ method: 'searchPage', args: [jql, undefined] });
  });

  it('still logs when Jira returns nothing or nothing changes (AC-3)', async () => {
    const { jira, h, lines } = setup();
    await h.engine.runTaskSync();
    const finished = () => texts(lines, 'info').filter((t) => t.includes('finished'));
    expect(finished()).toHaveLength(1);
    expect(finished()[0]).toContain('0 new, 0 updated; Jira returned 0 issues; JQL: ');

    jira.setIssues([issue(1), issue(2), issue(3)]);
    await h.engine.runTaskSync(); // imports 3
    await h.engine.runTaskSync(); // nothing changes
    expect(finished()).toHaveLength(3);
    expect(finished()[2]).toContain('0 new, 0 updated; Jira returned 3 issues; JQL: ');
  });

  it('logs a Jira failure at error level with the safe message (AC-4)', async () => {
    const { jira, h, lines } = setup();
    jira.failNext(new JiraError('auth', 'Jira rejected the credentials (HTTP 401)'));
    expect(await h.engine.runTaskSync()).toEqual({
      outcome: 'error',
      message: 'Jira rejected the credentials (HTTP 401)',
    });
    expect(texts(lines, 'error')).toEqual([
      'Jira task sync failed: Jira rejected the credentials (HTTP 401)',
    ]);
  });

  it('adds only the error class name for an unexpected error', async () => {
    const { jira, h, lines } = setup();
    jira.failNext(new TypeError('secret detail'));
    await h.engine.runTaskSync();
    expect(texts(lines, 'error')).toEqual([
      'Jira task sync failed: Sync failed unexpectedly (TypeError)',
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret detail');
  });

  describe('without credentials (AC-5)', () => {
    const saved = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
    afterEach(() => {
      for (const [k, v] of [
        ['JIRA_EMAIL', saved.email],
        ['JIRA_API_TOKEN', saved.token],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('logs the missing credentials', async () => {
      delete process.env.JIRA_EMAIL;
      delete process.env.JIRA_API_TOKEN;
      const { logger, lines } = captureLogger();
      const h = makeEngine({ logger });
      h.engine.updateSetting('jira_base_url', BASE_URL);
      await h.engine.runTaskSync();
      expect(texts(lines, 'error')).toEqual([
        'Jira task sync failed: Jira credentials are not set (JIRA_EMAIL and JIRA_API_TOKEN)',
      ]);
    });
  });

  it('logs that nothing ran when jira_base_url is empty, with no Jira request (AC-6)', async () => {
    const { jira, h, lines } = setup(false);
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'not_configured' });
    expect(texts(lines, 'info')).toEqual(['Jira task sync did not run: jira_base_url is not set']);
    expect(jira.calls).toEqual([]);
  });

  it('logs a skipped run while another sync is in flight (AC-7)', async () => {
    const { jira, h, lines } = setup();
    jira.block();
    const first = h.engine.runTaskSync();
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'skipped' });
    expect(texts(lines, 'info')).toContain('Jira task sync skipped: another sync is running');
    jira.release();
    await first;
  });
});

describe('comment sync log lines (AC-8)', () => {
  const c = (id: string) => ({ id, body: `text ${id}`, createdAt: '2026-11-20T09:00:00.000Z' });

  it('logs start and finish with the tasks checked, also for 0 new comments', async () => {
    const { h, lines } = setup();
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    rawTask(h.raw, { jiraKey: 'P-2', status: 'running' });
    await h.engine.runCommentSync();
    expect(texts(lines, 'info')).toEqual([
      'Jira comment sync started',
      'Jira comment sync finished: comments: 0 new; 2 tasks checked',
    ]);
  });

  it('logs the number of new comments', async () => {
    const { jira, h, lines } = setup();
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    jira.setComments('P-1', [c('10'), c('11')]);
    await h.engine.runCommentSync();
    expect(texts(lines, 'info')).toContain(
      'Jira comment sync finished: comments: 2 new; 1 tasks checked',
    );
  });

  it('logs a failure at error level with the safe message', async () => {
    const { jira, h, lines } = setup();
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    jira.failNext(new JiraError('server', 'Jira returned an error (HTTP 500)'));
    await h.engine.runCommentSync();
    expect(texts(lines, 'error')).toEqual([
      'Jira comment sync failed: Jira returned an error (HTTP 500)',
    ]);
  });

  it('logs not configured and skipped runs with the comment label', async () => {
    const off = setup(false);
    await off.h.engine.runCommentSync();
    expect(texts(off.lines, 'info')).toEqual([
      'Jira comment sync did not run: jira_base_url is not set',
    ]);

    const { jira, h, lines } = setup();
    jira.block();
    const first = h.engine.runTaskSync();
    await h.engine.runCommentSync();
    expect(texts(lines, 'info')).toContain('Jira comment sync skipped: another sync is running');
    jira.release();
    await first;
  });
});
