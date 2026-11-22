import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '@jiraffe/engine';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { buildServer } from '@jiraffe/server';

const TOKEN = 'tok-MARKER-s3cr3t-7f3a';
const EMAIL = 'marker.owner@example.test';
const LOCAL_HOST = { host: '127.0.0.1:4317' };
const BASE = 'https://example.atlassian.net';

let dir: string;
let engine: Engine;
let logs: unknown[];
beforeEach(() => {
  process.env.JIRA_EMAIL = EMAIL;
  process.env.JIRA_API_TOKEN = TOKEN;
  logs = [];
  dir = mkdtempSync(join(tmpdir(), 'jiraffe-root-'));
});
afterEach(() => {
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const raw = () => engine.ctx.db.$client;

function dumpDatabase(): string {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return JSON.stringify(tables.map((t) => raw().prepare(`SELECT * FROM "${t.name}"`).all()));
}

const searchBody = (issues: object[]) => JSON.stringify({ issues });
const rawIssue = (key: string, summary: string, description: string) => ({
  key,
  fields: {
    summary,
    description: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
    },
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    project: { key: key.split('-')[0] },
  },
});

describe('secrets never reach the database or logs (AC-74)', () => {
  it('keeps the token and e-mail out of every table and log line', async () => {
    engine = createEngine({
      dbPath: join(dir, 't.db'),
      version: 'test',
      logger: { error: (m, e) => logs.push([m, e instanceof Error ? e.message : e]) },
    });
    const app = buildServer(engine);
    await app.inject({
      headers: LOCAL_HOST,
      method: 'PUT',
      url: '/api/settings/jira_base_url',
      payload: { value: BASE },
    });

    // Flow 1: Jira rejects the credentials.
    const sent: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(String((init.headers as Record<string, string>).authorization));
      return new Response(`denied for ${TOKEN} and ${EMAIL}`, { status: 401 });
    }) as unknown as typeof fetch;
    const failed = await app.inject({ headers: LOCAL_HOST, method: 'POST', url: '/api/sync' });
    expect(failed.json().outcome).toBe('error');
    expect(failed.body).not.toContain(TOKEN);
    expect(sent[0]).toContain('Basic '); // the credentials are really used for the header

    // Flow 2: a good sync, then comment sync, local tasks, messages, delete and restore.
    globalThis.fetch = (async () =>
      new Response(searchBody([rawIssue('PROJ-1', 'Imported', 'Body')]), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      (await app.inject({ headers: LOCAL_HOST, method: 'POST', url: '/api/sync' })).json().outcome,
    ).toBe('ok');
    await app.inject({
      headers: LOCAL_HOST,
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Local', description: 'd', repoPath: '/r' },
    });
    await app.inject({
      headers: LOCAL_HOST,
      method: 'POST',
      url: '/api/tasks/2/messages',
      payload: { content: 'hello' },
    });
    await app.inject({ headers: LOCAL_HOST, method: 'DELETE', url: '/api/tasks/2' });
    await app.inject({ headers: LOCAL_HOST, method: 'POST', url: '/api/tasks/2/restore' });
    await app.close();

    const state = JSON.stringify([
      engine.syncState(),
      engine.readSettings(),
      engine.listJournal({ limit: 1000 }),
    ]);
    const encoded = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
    for (const secret of [TOKEN, EMAIL, encoded]) {
      expect(dumpDatabase(), `db has ${secret}`).not.toContain(secret);
      expect(JSON.stringify(logs), `logs have ${secret}`).not.toContain(secret);
      expect(state, `state has ${secret}`).not.toContain(secret);
    }
  });
});

describe('journal never holds free text (AC-75)', () => {
  it('keeps titles, descriptions and comment text out of journal details', async () => {
    const jira = new FakeJiraClient();
    engine = createEngine({
      dbPath: join(dir, 't.db'),
      version: 'test',
      jiraClient: jira,
      logger: { error() {} },
    });
    engine.updateSetting('jira_base_url', BASE);
    const M = {
      title: 'MARK_TITLE',
      body: 'MARK_BODY',
      comment: 'MARK_COMMENT',
      msg: 'MARK_MESSAGE',
      newTitle: 'MARK_NEWTITLE',
      newBody: 'MARK_NEWBODY',
    };

    jira.setIssues([
      {
        key: 'PROJ-1',
        projectKey: 'PROJ',
        title: M.title,
        description: M.body,
        statusName: 'To Do',
        statusCategory: 'new',
      },
    ]);
    await engine.runTaskSync();
    const jiraTask = (raw().prepare('SELECT id FROM tasks').get() as { id: number }).id;
    const local = engine.createLocalTask({
      title: M.title,
      description: M.body,
      repoPath: '/repo/MARK_PATH',
    });
    engine.addUserMessage(local.id, M.msg);

    raw().prepare("UPDATE tasks SET status = 'waiting_user' WHERE id = ?").run(jiraTask);
    jira.setComments('PROJ-1', [
      { id: '1', body: M.comment, createdAt: '2026-11-20T09:00:00.000Z' },
    ]);
    await engine.runCommentSync();
    jira.setIssues([
      {
        key: 'PROJ-1',
        projectKey: 'PROJ',
        title: M.newTitle,
        description: M.newBody,
        statusName: 'To Do',
        statusCategory: 'new',
      },
    ]);
    await engine.runTaskSync();
    engine.deleteTask(local.id);
    engine.restoreTask(local.id);
    engine.updateSetting('repo_map', { PROJ: '/repo/MARK_PATH' });

    const journal = engine.listJournal({ limit: 1000 });
    expect(journal.length).toBeGreaterThan(8);
    const actions = new Set(journal.map((j) => j.action));
    for (const a of [
      'task_imported',
      'task_created',
      'comment_added',
      'task_updated_from_jira',
      'task_deleted',
      'task_restored',
      'settings_changed',
      'sync_run',
      'status_changed',
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
    const everything = JSON.stringify(journal);
    for (const marker of Object.values(M).concat(['MARK_PATH']))
      expect(everything, marker).not.toContain(marker);
  });
});
