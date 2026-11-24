import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner, makeTempRepo, verdictBlock } from '@jiraffe/adapters/testing';
import { createEngine, type Engine } from '@jiraffe/engine';

let dir: string;
let engine: Engine;
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the full flow with fakes (AC-82)', () => {
  it('writes one event and one journal row per transition, in order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jiraffe-flow-'));
    const repo = makeTempRepo();
    const verdict = `done\n${verdictBlock({ summary: 'fine' })}`;
    const fake = new FakeRunner((c) =>
      c.prompt.includes('read-only')
        ? { lines: verdict.split('\n').map((text) => ({ stream: 'stdout' as const, text })) }
        : {},
    );
    engine = createEngine({
      dbPath: join(dir, 't.db'),
      version: 'test',
      logger: { info() {}, error() {} },
      runners: { copilot: fake },
      git: realGit,
    });
    engine.updateSetting('worktrees_dir', join(dir, 'worktrees'));
    engine.updateSetting('auto_analysis', true);
    const id = engine.createLocalTask({ title: 'Flow', description: 'd', repoPath: repo.path }).id;

    engine.transition(id, 'enqueue');
    await engine.start();
    await engine.idle();
    expect(engine.getTask(id).status).toBe('ready_to_delegate');
    engine.delegate(id);
    await engine.idle();
    expect(engine.getTask(id).status).toBe('review');
    engine.transition(id, 'review_accepted');
    expect(engine.getTask(id).status).toBe('done');

    const raw = engine.ctx.db.$client;
    const events = raw
      .prepare(
        `SELECT type FROM events WHERE task_id = ? AND type NOT IN ('agent_output','log_truncated','run_error','user_comment') ORDER BY id`,
      )
      .all(id) as { type: string }[];
    const journal = raw
      .prepare("SELECT detail FROM journal WHERE action = 'status_changed' ORDER BY id")
      .all() as { detail: string }[];
    const steps = [
      ['enqueue', 'new to queued_analysis'],
      ['analysis_started', 'queued_analysis to analysing'],
      ['analysis_ready', 'analysing to ready_to_delegate'],
      ['delegate', 'ready_to_delegate to delegated'],
      ['execution_started', 'delegated to running'],
      ['execution_done', 'running to review'],
      ['review_accepted', 'review to done'],
    ];
    expect(events.map((e) => e.type)).toEqual(steps.map((s) => s[0]));
    expect(journal.map((j) => j.detail)).toEqual(steps.map((s) => s[1]));
  });
});
