import { afterEach, describe, expect, it } from 'vitest';
import { JiraError } from '@jiraffe/jira';
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
type H = ReturnType<typeof setup>['h'];
const rows = (h: H, action: string) =>
  h.engine
    .listJournal({ action })
    .reverse()
    .map((r) => ({ taskKey: r.taskKey, detail: r.detail }));
const authFail = () => new JiraError('auth', 'Jira rejected the credentials (HTTP 401)');
const finishLines = (lines: ReturnType<typeof setup>['lines']) =>
  lines.filter((l) => l.level === 'info' && l.text.includes('finished'));

describe('task sync_run rows', () => {
  it('writes one row with the returned count when something changed (AC-10)', async () => {
    const { jira, h } = setup();
    jira.setIssues([issue(1), issue(2)]);
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_run')).toEqual([
      { taskKey: null, detail: '2 new, 0 updated; Jira returned 2 issues' },
    ]);
  });

  it('writes one row for the first empty sync and emits a changed event (AC-11)', async () => {
    const { jira, h } = setup();
    jira.setIssues([]);
    const seen: number[] = [];
    h.engine.bus.onChanged(() => seen.push(rows(h, 'sync_run').length));
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_run')).toEqual([
      { taskKey: null, detail: '0 new, 0 updated; Jira returned 0 issues' },
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it('does not repeat an identical outcome but still logs it every time (AC-12)', async () => {
    const { h, lines } = setup();
    await h.engine.runTaskSync();
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_run')).toHaveLength(1);
    expect(finishLines(lines)).toHaveLength(2);
  });

  it('journals again when the outcome text changes', async () => {
    const { jira, h } = setup();
    await h.engine.runTaskSync();
    jira.setIssues([issue(1)]);
    await h.engine.runTaskSync(); // 1 new
    await h.engine.runTaskSync(); // 0 new, returned 1
    expect(rows(h, 'sync_run').map((r) => r.detail)).toEqual([
      '0 new, 0 updated; Jira returned 0 issues',
      '1 new, 0 updated; Jira returned 1 issues',
      '0 new, 0 updated; Jira returned 1 issues',
    ]);
  });
});

describe('sync_failed rows (AC-13)', () => {
  it('journals a failure once, again after a different outcome', async () => {
    const { jira, h } = setup();
    jira.failNext(authFail());
    await h.engine.runTaskSync();
    jira.failNext(authFail());
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_failed')).toEqual([
      { taskKey: null, detail: 'Jira rejected the credentials (HTTP 401)' },
    ]);
    await h.engine.runTaskSync(); // succeeds
    jira.failNext(authFail());
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_failed')).toHaveLength(2);
    expect(h.engine.syncState()).toMatchObject({
      state: 'error',
      lastError: 'Jira rejected the credentials (HTTP 401)',
    });
  });
});

describe('sync_skipped rows (AC-14)', () => {
  it('journals "not configured" once and repeats nothing', async () => {
    const { h } = setup(false);
    await h.engine.runTaskSync();
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_skipped')).toEqual([
      { taskKey: null, detail: 'Jira not configured: jira_base_url is empty' },
    ]);
    expect(h.engine.syncState().state).toBe('not_configured');
  });

  it('journals an in-flight skip once and repeats nothing', async () => {
    const { jira, h } = setup();
    jira.block();
    const first = h.engine.runTaskSync();
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'skipped' });
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'skipped' });
    jira.release();
    await first;
    expect(rows(h, 'sync_skipped')).toEqual([{ taskKey: null, detail: 'another sync is running' }]);
  });
});

describe('a failing journal write never changes the outcome (AC-15)', () => {
  const block = (h: H) =>
    h.raw.exec(
      "CREATE TRIGGER fail_journal BEFORE INSERT ON journal WHEN NEW.action IN ('sync_failed','sync_skipped') BEGIN SELECT RAISE(ABORT, 'journal blocked'); END",
    );
  const unblock = (h: H) => h.raw.exec('DROP TRIGGER fail_journal');
  const writeFailures = (lines: ReturnType<typeof setup>['lines']) =>
    lines.filter((l) => l.level === 'error' && l.text.includes('Could not write the sync outcome'));

  it('keeps the error outcome, logs the write failure and retries next time', async () => {
    const { jira, h, lines } = setup();
    block(h);
    jira.failNext(authFail());
    expect(await h.engine.runTaskSync()).toEqual({
      outcome: 'error',
      message: 'Jira rejected the credentials (HTTP 401)',
    });
    expect(h.engine.syncState()).toMatchObject({ state: 'error' });
    expect(writeFailures(lines)).toHaveLength(1);
    expect(rows(h, 'sync_failed')).toEqual([]);

    unblock(h);
    jira.failNext(authFail());
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_failed')).toHaveLength(1);
  });

  it('keeps the not_configured outcome and retries next time', async () => {
    const { h, lines } = setup(false);
    block(h);
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'not_configured' });
    expect(h.engine.syncState().state).toBe('not_configured');
    expect(writeFailures(lines)).toHaveLength(1);

    unblock(h);
    await h.engine.runTaskSync();
    expect(rows(h, 'sync_skipped')).toHaveLength(1);
  });

  it('keeps the skipped outcome', async () => {
    const { jira, h, lines } = setup();
    jira.block();
    const first = h.engine.runTaskSync();
    block(h);
    expect(await h.engine.runTaskSync()).toEqual({ outcome: 'skipped' });
    expect(writeFailures(lines)).toHaveLength(1);
    jira.release();
    await first;
  });
});

describe('task and comment sync keep separate memories (AC-16)', () => {
  it('alternating identical outcomes add one row per kind', async () => {
    const { h } = setup();
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    for (let i = 0; i < 3; i++) {
      await h.engine.runTaskSync();
      await h.engine.runCommentSync();
    }
    expect(rows(h, 'sync_run').map((r) => r.detail)).toEqual([
      '0 new, 0 updated; Jira returned 0 issues',
      'comments: 0 new',
    ]);
  });

  it('keeps the failure memory per kind', async () => {
    const { jira, h } = setup();
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    jira.failNext(authFail());
    await h.engine.runTaskSync();
    jira.failNext(authFail());
    await h.engine.runCommentSync();
    expect(rows(h, 'sync_failed')).toHaveLength(2);
  });
});
