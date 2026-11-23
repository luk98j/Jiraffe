import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner } from '@jiraffe/adapters/testing';
import { buildContext } from '../src/contextFile.ts';
import { disposeAll, makeEngine, newTaskIn, statusOf, useRepo } from './helpers.ts';

const SENTINELS = {
  JIRA_EMAIL: 'ctx.sentinel@example.test',
  JIRA_API_TOKEN: 'tok-CTXFILE-SENTINEL-91c2',
  JIRAFFE_TEST_OTHER_SECRET: 'other-env-SENTINEL-77aa',
};

afterEach(() => {
  disposeAll();
  for (const k of Object.keys(SENTINELS)) delete process.env[k];
});

describe('the context file carries no secrets (AC-47)', () => {
  it('keeps every env sentinel out of the file and the prompt, while the task text is present', async () => {
    Object.assign(process.env, SENTINELS);
    const fake = new FakeRunner({});
    const h = makeEngine({ runners: { copilot: fake }, git: realGit });
    const repo = useRepo(h);
    const id = newTaskIn(h.engine, 'ready_to_delegate', 'analysing', repo.path);
    h.raw
      .prepare('UPDATE tasks SET title = ?, body = ? WHERE id = ?')
      .run('JIRA_TITLE_TEXT', 'JIRA_BODY_TEXT', id);
    h.raw
      .prepare(
        "INSERT INTO messages (task_id, role, source, content, created_at) VALUES (?, 'user', 'jira', 'JIRA_COMMENT_TEXT', '2000-01-01T00:00:00.000Z')",
      )
      .run(id);
    h.raw
      .prepare(
        `INSERT INTO runs (task_id, kind, end_reason, finished_at, result_json)
         VALUES (?, 'analysis', 'completed', 'x', ?)`,
      )
      .run(
        id,
        JSON.stringify({
          role: 'analyst',
          verdict: {
            verdict: 'READY',
            questions: [],
            missing: [],
            permissions: ['read: src/**'],
            summary: 'S',
          },
        }),
      );
    h.engine.delegate(id);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('review');

    const file = readFileSync(join(repo.worktrees, 'LOC-0001', '.orchestrator/context.md'), 'utf8');
    expect(file).toContain('JIRA_COMMENT_TEXT'); // the content is really there
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(file, `file has ${name}`).not.toContain(value);
      expect(fake.calls[0]!.prompt, `prompt has ${name}`).not.toContain(value);
    }
  });

  it('the builder only uses its input: env values never enter the text', () => {
    Object.assign(process.env, SENTINELS);
    const text = buildContext({
      key: 'PROJ-1',
      status: 'running',
      analysis: [],
      comments: [{ source: 'jira', content: 'a comment', createdAt: 'x' }],
    });
    for (const value of Object.values(SENTINELS)) expect(text).not.toContain(value);
    expect(text).toContain('a comment');
  });
});
