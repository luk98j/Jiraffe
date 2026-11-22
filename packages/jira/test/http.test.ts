import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JiraError, createHttpJiraClient } from '../src/index.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const TOKEN = 'secret-token-123';
const EMAIL = 'me@example.com';

function client(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    jira: createHttpJiraClient({
      baseUrl: 'https://x.atlassian.net',
      email: EMAIL,
      token: TOKEN,
      fetch: fetchFn,
    }),
  };
}
const json = (body: string, status = 200) => new Response(body, { status });

describe('createHttpJiraClient', () => {
  it('sends basic auth and maps issues and the cursor', async () => {
    const { jira, calls } = client((url) =>
      json(
        fixture(url.searchParams.get('nextPageToken') ? 'search-page2.json' : 'search-page1.json'),
      ),
    );
    const p1 = await jira.searchPage('assignee = currentUser()');
    expect(p1.nextCursor).toBe('tok-2');
    expect(p1.issues[0]).toEqual({
      key: 'PROJ-1',
      projectKey: 'PROJ',
      title: 'First issue',
      description: 'Hello world\nSecond line',
      statusName: 'To Do',
      statusCategory: 'new',
    });
    expect(p1.issues[1]?.description).toBeNull();
    const p2 = await jira.searchPage('q', p1.nextCursor);
    expect(p2.nextCursor).toBeUndefined();
    expect(p2.issues[0]?.statusCategory).toBe('done');

    const auth = (calls[0]!.init.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`);
    expect(calls[0]!.url.searchParams.get('jql')).toBe('assignee = currentUser()');
    expect(calls[1]!.url.searchParams.get('nextPageToken')).toBe('tok-2');
  });

  it('getIssues looks keys up with a key IN query and rejects malformed keys', async () => {
    const { jira, calls } = client(() => json(fixture('search-page2.json')));
    const got = await jira.getIssues(['ABC-7']);
    expect(got.map((i) => i.key)).toEqual(['ABC-7']);
    expect(calls[0]!.url.searchParams.get('jql')).toBe('key IN (ABC-7)');
    await expect(jira.getIssues(['A-1) OR (x'])).rejects.toBeInstanceOf(JiraError);
    expect(await jira.getIssues([])).toEqual([]);
  });

  it('maps comments', async () => {
    const { jira } = client(() => json(fixture('comments.json')));
    expect(await jira.getComments('PROJ-1')).toEqual([
      { id: '100', body: 'A comment', createdAt: '2026-11-01T10:00:00.000Z' },
      { id: '101', body: '', createdAt: '2026-11-02T10:00:00.000Z' },
    ]);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('maps HTTP %i to %s without leaking secrets', async (status, kind) => {
    const { jira } = client(() => json(`body mentioning ${TOKEN} and ${EMAIL}`, status));
    const err = await jira.searchPage('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).kind).toBe(kind);
    expect((err as JiraError).message).toContain(String(status));
    for (const secret of [TOKEN, EMAIL, 'x.atlassian.net']) {
      expect((err as JiraError).message).not.toContain(secret);
    }
  });

  it('maps a thrown network error and invalid JSON', async () => {
    const a = client(() => {
      throw new Error(`connect failed for ${TOKEN}`);
    });
    const err = await a.jira.searchPage('q').catch((e: unknown) => e);
    expect((err as JiraError).kind).toBe('network');
    expect((err as JiraError).message).not.toContain(TOKEN);
    const b = client(() => json('not json'));
    await expect(b.jira.searchPage('q')).rejects.toMatchObject({ kind: 'server' });
  });
});
