import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpJiraClient } from '@jiraffe/jira';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import {
  BASE_URL,
  captureLogger,
  disposeAll,
  issue,
  makeEngine,
  rawTask,
  type LogLine,
} from './helpers.ts';

const EMAIL = 'sentinel-owner@example.test';
const TOKEN = 'tok-SENTINEL-4242';
const SECRETS = [EMAIL, TOKEN, Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')];
const saved = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };

beforeEach(() => {
  process.env.JIRA_EMAIL = EMAIL;
  process.env.JIRA_API_TOKEN = TOKEN;
});
afterEach(() => {
  disposeAll();
  for (const [k, v] of [
    ['JIRA_EMAIL', saved.email],
    ['JIRA_API_TOKEN', saved.token],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every logger call, with Error arguments expanded to message and stack. */
const dumpLines = (lines: LogLine[]) =>
  JSON.stringify(
    lines.map((l) => ({
      ...l,
      extra: l.extra.map((e) => (e instanceof Error ? { message: e.message, stack: e.stack } : e)),
    })),
  );

function expectClean(h: ReturnType<typeof makeEngine>, lines: LogLine[]) {
  const everything = JSON.stringify([
    dumpLines(lines),
    h.engine.listJournal({ limit: 1000 }),
    h.engine.syncState(),
    h.engine.ctx.sync.lastJournaled,
  ]);
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
}

function setup(jira: FakeJiraClient | undefined) {
  const { logger, lines } = captureLogger();
  const h = makeEngine({ ...(jira ? { jiraClient: jira } : {}), logger });
  h.engine.updateSetting('jira_base_url', BASE_URL);
  return { h, lines };
}

describe('credentials never reach logs, journal or sync state (AC-9)', () => {
  it('success with changes and with none, task and comment sync', async () => {
    const jira = new FakeJiraClient();
    jira.setIssues([issue(1)]);
    const { h, lines } = setup(jira);
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    await h.engine.runTaskSync();
    await h.engine.runTaskSync();
    await h.engine.runCommentSync();
    expect(lines.length).toBeGreaterThan(0);
    expectClean(h, lines);
  });

  it('a raw non-Jira error that carries the credentials', async () => {
    const jira = new FakeJiraClient();
    const { h, lines } = setup(jira);
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    jira.failNext(new Error(`boom ${TOKEN} ${EMAIL}`));
    await h.engine.runTaskSync();
    jira.failNext(new Error(`boom ${TOKEN} ${EMAIL}`));
    await h.engine.runCommentSync();
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(2);
    expectClean(h, lines);
  });

  it('a Jira HTTP error whose response echoes the credentials', async () => {
    const real = createHttpJiraClient({
      baseUrl: BASE_URL,
      email: EMAIL,
      token: TOKEN,
      fetch: (async (_url: string, init: { headers: Record<string, string> }) =>
        new Response(`denied ${EMAIL} ${TOKEN} ${init.headers.Authorization ?? ''}`, {
          status: 401,
        })) as unknown as typeof fetch,
    });
    const { h, lines } = setup(real);
    rawTask(h.raw, { jiraKey: 'P-1', status: 'waiting_user' });
    expect((await h.engine.runTaskSync()).outcome).toBe('error');
    expect((await h.engine.runCommentSync()).outcome).toBe('error');
    expectClean(h, lines);
  });

  it('not configured and skipped runs', async () => {
    const off = setup(new FakeJiraClient());
    off.h.engine.updateSetting('jira_base_url', '');
    expect(await off.h.engine.runTaskSync()).toEqual({ outcome: 'not_configured' });
    expectClean(off.h, off.lines);

    const jira = new FakeJiraClient();
    const { h, lines } = setup(jira);
    jira.block();
    const first = h.engine.runTaskSync();
    await h.engine.runCommentSync();
    jira.release();
    await first;
    expectClean(h, lines);
  });
});
