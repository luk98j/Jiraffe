import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIFF_CAP,
  addInfoExclude,
  childEnv,
  deleteBranch,
  diffSince,
  ensureWorktree,
  headCommit,
  nodeSpawner,
  realGit,
  removeWorktree,
  resolveWorktreePath,
  runCommand,
} from '../src/index.ts';
import { FakeGit, makeTempRepo } from '../src/testing.ts';

function setup() {
  const repo = makeTempRepo();
  const wt = resolveWorktreePath(
    repo.path,
    '../.worktrees-test',
    `T-${Math.random().toString(36).slice(2, 8)}`,
  );
  if (!wt.ok) throw new Error(wt.reason);
  return { ...repo, wt: wt.path, branch: `task/${wt.path.split('/').pop()}` };
}

describe('worktree against a real repository (AC-41, AC-44, AC-46, AC-51, AC-52)', () => {
  it('creates the worktree on a new branch and reports HEAD', async () => {
    const r = setup();
    const head = await headCommit(realGit, r.path);
    expect(head).toMatchObject({ ok: true });
    expect(await ensureWorktree(realGit, r.path, r.wt, r.branch, false)).toEqual({
      ok: true,
      created: true,
    });
    expect(existsSync(join(r.wt, 'a.txt'))).toBe(true);
    expect(r.git('branch', '--list', r.branch)).toContain(r.branch);
  });

  it('reuses an existing worktree and keeps its commits (AC-44)', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, true);
    writeFileSync(join(r.wt, 'b.txt'), 'work\n');
    const inWt = (...a: string[]) =>
      realGit.run(['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...a], { cwd: r.wt });
    await inWt('add', '-A');
    await inWt('commit', '-q', '-m', 'work');
    expect(await ensureWorktree(realGit, r.path, r.wt, r.branch, true)).toEqual({
      ok: true,
      created: false,
    });
    expect(existsSync(join(r.wt, 'b.txt'))).toBe(true);
  });

  it('attaches to an existing branch whose worktree was removed, without -b or reset', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, true);
    writeFileSync(join(r.wt, 'c.txt'), 'x\n');
    await realGit.run(['add', '-A'], { cwd: r.wt });
    await realGit.run(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'c'],
      { cwd: r.wt },
    );
    expect(await removeWorktree(realGit, r.path, r.wt)).toEqual({ ok: true });
    expect(await ensureWorktree(realGit, r.path, r.wt, r.branch, true)).toEqual({
      ok: true,
      created: false,
    });
    expect(existsSync(join(r.wt, 'c.txt'))).toBe(true);
  });

  it('reports the git error tail when the repository is not a repository', async () => {
    const r = setup();
    const res = await ensureWorktree(realGit, join(r.path, 'nope'), r.wt, r.branch, true);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('git') });
  });

  it('writes .orchestrator/ to the exclude file git reports, also in a linked worktree', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, true);
    expect(await addInfoExclude(realGit, r.wt)).toEqual({ ok: true });
    await addInfoExclude(realGit, r.wt); // twice: still one line
    const file = (
      await realGit.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: r.wt })
    ).stdout.trim();
    const text = readFileSync(file.startsWith('/') ? file : join(r.wt, file), 'utf8');
    expect(text.split('\n').filter((l) => l === '.orchestrator/')).toHaveLength(1);
    writeFileSync(join(r.wt, 'x.txt'), '1');
    await realGit.run(['add', '--intent-to-add', '-A'], { cwd: r.wt });
    expect((await realGit.run(['status', '--porcelain'], { cwd: r.wt })).stdout).not.toContain(
      '.orchestrator',
    );
  });

  it('diffs committed, uncommitted and new files against the base', async () => {
    const r = setup();
    const base = (await headCommit(realGit, r.path)) as { commit: string };
    await ensureWorktree(realGit, r.path, r.wt, r.branch, true);
    writeFileSync(join(r.wt, 'a.txt'), 'one\nchanged\n');
    writeFileSync(join(r.wt, 'new.txt'), 'brand new\n');
    const d = await diffSince(realGit, r.wt, base.commit);
    expect(d).toMatchObject({ ok: true, truncated: false });
    if (d.ok) {
      expect(d.diff).toContain('+changed');
      expect(d.diff).toContain('new.txt');
      expect(d.diff).toContain('+brand new');
    }
  });

  it('refuses a base that is not a commit hash', async () => {
    const r = setup();
    expect(await diffSince(realGit, r.path, '--output=/tmp/x')).toMatchObject({ ok: false });
  });

  it('removes the worktree and deletes the branch', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, true);
    expect(await removeWorktree(realGit, r.path, r.wt)).toEqual({ ok: true });
    expect(existsSync(r.wt)).toBe(false);
    expect(await deleteBranch(realGit, r.path, r.branch)).toEqual({ ok: true });
    expect(r.git('branch', '--list', r.branch).trim()).toBe('');
  });
});

describe('ownership of the worktree and branch', () => {
  it('refuses to take over a branch that Jiraffe did not create, and creates nothing', async () => {
    const r = setup();
    r.git('branch', r.branch); // someone else's branch with the same name
    const res = await ensureWorktree(realGit, r.path, r.wt, r.branch, false);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('was not created by Jiraffe'),
    });
    expect(existsSync(r.wt)).toBe(false);
  });

  it('refuses a worktree that already exists but is not owned', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, false);
    expect(await ensureWorktree(realGit, r.path, r.wt, r.branch, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not created by Jiraffe'),
    });
  });

  it('reuses an owned branch without creating it again', async () => {
    const r = setup();
    await ensureWorktree(realGit, r.path, r.wt, r.branch, false);
    await removeWorktree(realGit, r.path, r.wt);
    expect(await ensureWorktree(realGit, r.path, r.wt, r.branch, true)).toEqual({
      ok: true,
      created: false,
    });
  });
});

describe('diff cap (AC-52)', () => {
  it('truncates at 1 MiB with a visible marker', async () => {
    const git = new FakeGit((args) =>
      args[0] === 'diff' ? { stdout: 'x'.repeat(DIFF_CAP), truncated: true } : {},
    );
    const d = await diffSince(git, '/w', 'a'.repeat(40));
    expect(d).toMatchObject({ ok: true, truncated: true });
    if (d.ok) expect(d.diff.endsWith('[diff truncated at 1 MiB]\n')).toBe(true);
    expect(git.calls.map((c) => c.args[0])).toEqual(['add', 'diff']);
  });
});

describe('git calls are argument arrays (AC-43)', () => {
  it('passes the branch and path as separate arguments', async () => {
    const git = new FakeGit((args) => (args[0] === 'rev-parse' ? { code: 1 } : {}));
    await ensureWorktree(git, '/repo', '/w/KEY-1', 'task/KEY-1', false);
    expect(git.calls.map((c) => c.args)).toContainEqual([
      'worktree',
      'add',
      '/w/KEY-1',
      '-b',
      'task/KEY-1',
    ]);
    for (const c of git.calls) expect(c.args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('child environment', () => {
  it('drops the Jira credentials and keeps the rest', () => {
    const env = childEnv({ JIRA_EMAIL: 'a@b', JIRA_API_TOKEN: 't', PATH: '/bin', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('a real child process does not see JIRA_EMAIL or JIRA_API_TOKEN', async () => {
    process.env.JIRA_EMAIL = 'env.mark@example.test';
    process.env.JIRA_API_TOKEN = 'tok-ENV-MARK';
    try {
      const lines: string[] = [];
      const h = runCommand(
        nodeSpawner,
        process.execPath,
        [
          '-e',
          "console.log(JSON.stringify([process.env.JIRA_EMAIL ?? null, process.env.JIRA_API_TOKEN ?? null, process.env.PATH ? 'path' : null]))",
        ],
        { cwd: process.cwd(), timeoutMs: 10_000, onOutput: (l) => lines.push(l.text) },
      );
      await h.result;
      expect(JSON.parse(lines[0] as string)).toEqual([null, null, 'path']);
    } finally {
      delete process.env.JIRA_EMAIL;
      delete process.env.JIRA_API_TOKEN;
    }
  });
});
