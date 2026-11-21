import { describe, expect, it } from 'vitest';
import { JiraError, fetchAllIssues, type JiraIssue } from '../src/index.ts';
import { FakeJiraClient } from '../src/fake.ts';

const issue = (n: number): JiraIssue => ({
  key: `P-${n}`,
  projectKey: 'P',
  title: `t${n}`,
  description: null,
  statusName: 'To Do',
  statusCategory: 'new',
});

describe('fetchAllIssues', () => {
  it('follows the cursor across 3 pages', async () => {
    const fake = new FakeJiraClient();
    fake.pageSize = 50;
    fake.setIssues(Array.from({ length: 120 }, (_, i) => issue(i + 1)));
    const all = await fetchAllIssues(fake, 'jql');
    expect(all).toHaveLength(120);
    expect(fake.calls.filter((c) => c.method === 'searchPage')).toHaveLength(3);
  });

  it('returns an empty list for an empty result', async () => {
    expect(await fetchAllIssues(new FakeJiraClient(), 'jql')).toEqual([]);
  });
});

describe('FakeJiraClient', () => {
  it('records calls with arguments', async () => {
    const fake = new FakeJiraClient();
    fake.setIssues([issue(1)]);
    await fake.searchPage('q');
    await fake.getIssues(['P-1']);
    await fake.getComments('P-1');
    expect(fake.calls).toEqual([
      { method: 'searchPage', args: ['q', undefined] },
      { method: 'getIssues', args: [['P-1']] },
      { method: 'getComments', args: ['P-1'] },
    ]);
  });

  it('getIssues returns only the requested keys; comments are per key', async () => {
    const fake = new FakeJiraClient();
    fake.setIssues([issue(1), issue(2)]);
    fake.setComments('P-1', [{ id: '1', body: 'x', createdAt: '2026-01-01T00:00:00.000Z' }]);
    expect((await fake.getIssues(['P-2'])).map((i) => i.key)).toEqual(['P-2']);
    expect(await fake.getComments('P-1')).toHaveLength(1);
    expect(await fake.getComments('P-2')).toEqual([]);
  });

  it('failNext fails exactly one call', async () => {
    const fake = new FakeJiraClient();
    fake.failNext(new JiraError('auth', 'nope'));
    await expect(fake.searchPage('q')).rejects.toMatchObject({ kind: 'auth' });
    await expect(fake.searchPage('q')).resolves.toEqual({ issues: [] });
  });

  it('block holds calls until release', async () => {
    const fake = new FakeJiraClient();
    fake.block();
    let done = false;
    const p = fake.searchPage('q').then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    fake.release();
    await p;
    expect(done).toBe(true);
  });
});
