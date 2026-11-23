import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner, gitSync, type FakeCall, type StubScript } from '@jiraffe/adapters/testing';
import {
  deferred,
  disposeAll,
  eventRows,
  makeEngine,
  newTaskIn,
  runRows,
  statusOf,
  useRepo,
} from './helpers.ts';

afterEach(() => {
  disposeAll();
  delete process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_EMAIL;
});

const gitIn = gitSync;

function setup(script: StubScript | ((c: FakeCall, n: number) => StubScript) = {}, over = {}) {
  const fake = new FakeRunner(script);
  const h = makeEngine({ runners: { copilot: fake }, git: realGit, ...over });
  const repo = useRepo(h);
  const id = newTaskIn(h.engine, 'ready_to_delegate', 'analysing', repo.path);
  return { fake, h, repo, id };
}
const run = async (h: ReturnType<typeof setup>['h'], id: number) => {
  h.engine.delegate(id);
  await h.engine.start();
  await h.engine.idle();
};

describe('worktree, context and review (AC-41, 46, 47, 48, 51)', () => {
  it('creates the worktree and branch, records them, starts only afterwards, runs in the worktree', async () => {
    const { fake, h, repo, id } = setup();
    const head = gitIn(repo.path, 'rev-parse', 'HEAD').trim();
    const wt = join(repo.worktrees, 'LOC-0001');
    const atStart: { exists: boolean; recorded: string | null }[] = [];
    h.engine.bus.onEvent((e) => {
      if (e.type === 'execution_started')
        atStart.push({
          exists: existsSync(wt),
          recorded: runRows(h)[0]?.id
            ? (h.raw.prepare('SELECT worktree_path p FROM runs').get() as { p: string | null }).p
            : null,
        });
    });
    await run(h, id);
    expect(statusOf(h, id)).toBe('review');
    expect(atStart).toEqual([{ exists: true, recorded: wt }]);
    expect(fake.calls[0]!.cwd).toBe(wt);
    expect(
      h.raw.prepare('SELECT worktree_path, branch, base_commit, end_reason FROM runs').get(),
    ).toEqual({
      worktree_path: wt,
      branch: 'task/LOC-0001',
      base_commit: head,
      end_reason: 'completed',
    });
    expect(gitIn(repo.path, 'branch', '--list', 'task/LOC-0001')).toContain('task/LOC-0001');
  });

  it('writes the context file, excludes it from git, and puts the same snapshot in the prompt', async () => {
    process.env.JIRA_API_TOKEN = 'tok-CTX-MARK';
    process.env.JIRA_EMAIL = 'ctx.mark@example.test';
    const { fake, h, repo, id } = setup();
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
            summary: 'SUMMARY_X',
          },
        }),
      );
    h.raw
      .prepare(
        "INSERT INTO messages (task_id, role, source, content, created_at) VALUES (?, 'user', 'jira', 'JIRA_NOTE', '2000-01-01T00:00:00.000Z')",
      )
      .run(id);
    h.engine.updateSetting('allowed_tools', ['git status']);
    await run(h, id);
    const wt = join(repo.worktrees, 'LOC-0001');
    const file = readFileSync(join(wt, '.orchestrator/context.md'), 'utf8');
    for (const part of [
      'LOC-0001',
      'SUMMARY_X',
      '[jira]',
      'JIRA_NOTE',
      'read: src/**',
      'not applied',
    ])
      expect(file).toContain(part);
    expect(fake.calls[0]!.prompt).toContain(file);
    expect(fake.calls[0]!.prompt).toContain('LOC-0001: T'); // the template placeholders are filled
    for (const text of [file, fake.calls[0]!.prompt]) {
      expect(text).not.toContain('tok-CTX-MARK');
      expect(text).not.toContain('ctx.mark@example.test');
    }
    expect(gitIn(wt, 'status', '--porcelain')).not.toContain('.orchestrator');
  });

  it('hands allowed_tools to the adapter exactly, not merged with the verdict permissions (AC-56)', async () => {
    const { fake, h, id } = setup();
    h.engine.updateSetting('allowed_tools', ['git status', 'gradle test']);
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
            permissions: ['run: rm -rf /'],
            summary: 's',
          },
        }),
      );
    await run(h, id);
    expect(fake.calls[0]!.options.allowedTools).toEqual(['git status', 'gradle test']);
    expect(fake.calls[0]!.options.maxCredits).toBe(2);
    expect(fake.calls[0]!.options.timeoutMs).toBe(30 * 60_000);
  });

  it('returns the diff against the recorded base, including new files (AC-51)', async () => {
    const { h, id } = setup((c) => {
      writeFileSync(join(c.cwd, 'a.txt'), 'one\nedited\n');
      writeFileSync(join(c.cwd, 'new.txt'), 'created\n');
      return {};
    });
    await run(h, id);
    expect(statusOf(h, id)).toBe('review');
    const d = await h.engine.getDiff(id);
    expect(d.diff).toContain('+edited');
    expect(d.diff).toContain('+created');
    expect(d.truncated).toBe(false);
    expect(d.base).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('failures before the agent starts (AC-45, X1)', () => {
  async function failing(prepare: (h: ReturnType<typeof setup>) => void) {
    const s = setup();
    prepare(s);
    const seen: string[] = [];
    s.h.engine.bus.onChanged(() => seen.push(statusOf(s.h, s.id)));
    await run(s.h, s.id);
    return { ...s, seen };
  }
  const expectFailed = (s: Awaited<ReturnType<typeof failing>>, pattern: RegExp) => {
    expect(statusOf(s.h, s.id)).toBe('failed');
    expect(s.fake.calls).toEqual([]); // no agent started
    expect(s.seen).not.toContain('running');
    expect(eventRows(s.h, 'execution_started', s.id)).toHaveLength(1);
    expect(runRows(s.h)[0]).toMatchObject({ end_reason: 'crashed', status: 'finished' });
    const detail = s.h.engine.getTaskDetail(s.id);
    expect(detail.lastError?.message).toMatch(pattern);
  };

  it('repository path missing', async () => {
    const s = await failing((x) =>
      x.h.engine.setRepository(x.id, join(tmpdir(), 'jiraffe-no-such-repo')),
    );
    expectFailed(s, /git/i);
  });

  it('path is not a git repository', async () => {
    const s = await failing((x) =>
      x.h.engine.setRepository(x.id, mkdtempSync(join(tmpdir(), 'jiraffe-plain-'))),
    );
    expectFailed(s, /HEAD|git/i);
  });

  it('worktrees_dir points inside .git', async () => {
    const s = await failing((x) =>
      x.h.engine.updateSetting('worktrees_dir', join(x.repo.path, '.git', 'wt')),
    );
    expectFailed(s, /\.git/);
  });

  it('git refuses the worktree', async () => {
    const s = await failing((x) => {
      // An existing, non-empty, unregistered directory where the worktree should go.
      const dir = join(x.repo.worktrees, 'LOC-0001');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'f'), '1');
    });
    expectFailed(s, /worktree add failed/);
  });
});

describe('retry reuses the worktree (AC-44, AC-54)', () => {
  it('keeps commits, keeps the first base, warns about restart, and gives the new comment to the next run', async () => {
    let now = Date.parse('2026-11-23T10:00:00.000Z');
    const gate = deferred();
    const { fake, h, repo, id } = setup(
      (c, n) => {
        if (n === 1) {
          writeFileSync(join(c.cwd, 'work.txt'), 'first\n');
          gitIn(c.cwd, 'add', '-A');
          gitIn(c.cwd, 'commit', '-q', '-m', 'first run');
          return {
            until: gate.promise,
            exitCode: 1,
            lines: [{ stream: 'stderr', text: 'tests failed' }],
          };
        }
        return {};
      },
      { clock: () => new Date(now) },
    );
    h.engine.delegate(id);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(statusOf(h, id)).toBe('running');
    // AC-54: a comment during the run is stored, marked, and does not interrupt or start anything.
    now += 60_000;
    h.engine.addUserMessage(id, 'EXTRA_NOTE');
    expect(h.engine.listMessages(id)[0]?.waitsForNextRun).toBe(true);
    expect(fake.calls).toHaveLength(1);
    gate.resolve();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    expect(h.engine.getTaskDetail(id).lastError).toMatchObject({
      tail: expect.stringContaining('tests failed'),
    });

    // The second run: put the task back to delegated (the engine's own retry goes through analysis).
    h.raw.prepare("UPDATE tasks SET status = 'delegated' WHERE id = ?").run(id);
    expect(h.engine.getTaskDetail(id).restartsInWorktree).toBe(true);
    h.engine.ctx.workers.pump();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('review');
    const wt = join(repo.worktrees, 'LOC-0001');
    expect(readFileSync(join(wt, 'work.txt'), 'utf8')).toBe('first\n');
    expect(gitIn(wt, 'log', '--format=%s')).toContain('first run');
    expect(fake.calls[1]!.prompt).toContain('EXTRA_NOTE');
    const bases = h.raw.prepare('SELECT base_commit b FROM runs ORDER BY id').all() as {
      b: string;
    }[];
    expect(bases[1]!.b).toBe(bases[0]!.b);
    expect(runRows(h)).toHaveLength(2);
  });
});

describe('logs (AC-49, AC-50)', () => {
  it('stores each line with its stream and pages them by event id', async () => {
    const { h, id } = setup({
      lines: [
        { stream: 'stdout', text: 'one' },
        { stream: 'stderr', text: 'two' },
        { stream: 'stdout', text: 'three' },
      ],
    });
    let changes = 0;
    h.engine.bus.onChanged(() => changes++);
    await run(h, id);
    const first = h.engine.getLogs(id, 0, 2);
    expect(first.lines.map((l) => [l.stream, l.text])).toEqual([
      ['stdout', 'one'],
      ['stderr', 'two'],
    ]);
    const rest = h.engine.getLogs(id, first.lines.at(-1)!.id, 500);
    expect(rest.lines.map((l) => l.text)).toEqual(['three']);
    expect(rest.truncated).toBe(false);
    expect(changes).toBeGreaterThan(0);
  });

  it('stops storing at 5 MiB, writes one log_truncated event, and the run still finishes', async () => {
    const big = 'x'.repeat(1024 * 1024);
    const { h, id } = setup({
      lines: Array.from({ length: 6 }, () => ({ stream: 'stdout' as const, text: big })),
    });
    await run(h, id);
    expect(statusOf(h, id)).toBe('review');
    expect(eventRows(h, 'agent_output', id)).toHaveLength(5);
    expect(eventRows(h, 'log_truncated', id)).toHaveLength(1);
    expect(h.engine.getLogs(id, 0, 500).truncated).toBe(true);
  });
});

describe('a simulated CLI refusal (AC-57)', () => {
  it('records the refusal as a failed run and keeps the worker alive for the next task', async () => {
    const fake = new FakeRunner((_c, n) => ({ tryCommand: n === 1 ? 'rm -rf /' : 'git status' }));
    const h = makeEngine({ runners: { copilot: fake }, git: realGit });
    const repo = useRepo(h);
    h.engine.updateSetting('max_parallel_execution', 1);
    const a = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    const b = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, a)).toBe('failed');
    expect(h.engine.getTaskDetail(a).lastError?.tail).toContain('refused: rm -rf /');
    expect(statusOf(h, b)).toBe('review');
  });
});
