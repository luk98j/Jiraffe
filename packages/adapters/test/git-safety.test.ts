import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffSince, ensureWorktree, gitEnv, headCommit, realGit } from '../src/index.ts';
import { gitSync, makeTempRepo } from '../src/testing.ts';

afterEach(() => {
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.GIT_DIR;
});

describe('gitEnv', () => {
  it('drops the Jira credentials and inherited GIT_ variables, and sets the safe ones', () => {
    const env = gitEnv({
      JIRA_EMAIL: 'a@b',
      JIRA_API_TOKEN: 't',
      GIT_DIR: '/elsewhere',
      GIT_SSH_COMMAND: 'x',
      PATH: '/bin',
      HOME: '/h',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    });
  });

  it('a real git child process sees no JIRA_ variable and no inherited GIT_DIR', async () => {
    const repo = makeTempRepo();
    repo.git('config', 'alias.showenv', '!env'); // an alias runs a shell with git's own environment
    process.env.JIRA_EMAIL = 'env.mark@example.test';
    process.env.JIRA_API_TOKEN = 'tok-GIT-ENV-MARK';
    process.env.GIT_DIR = '/does/not/exist';
    const r = await realGit.run(['showenv'], { cwd: repo.path });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/JIRA_/);
    expect(r.stdout).not.toContain('tok-GIT-ENV-MARK');
    expect(r.stdout).toContain('GIT_TERMINAL_PROMPT=0');
    expect(r.stdout).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(r.stdout).not.toContain('GIT_DIR=');
  });
});

describe('a repository configured to run programs (SEC-1)', () => {
  function hostileRepo() {
    const repo = makeTempRepo();
    const marks = realpathSync(mkdtempSync(join(tmpdir(), 'jiraffe-marks-')));
    const script = (name: string, body: string) => {
      const file = join(marks, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const hooks = join(marks, 'hooks');
    mkdirSync(hooks);
    const hook = join(hooks, 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch "${marks}/hook"\n`);
    chmodSync(hook, 0o755);
    repo.git('config', 'core.hooksPath', hooks);
    repo.git('config', 'core.fsmonitor', script('fsmonitor.sh', `touch "${marks}/fsmonitor"`));
    repo.git('config', 'diff.external', script('ext.sh', `touch "${marks}/ext"`));
    writeFileSync(join(repo.path, '.gitattributes'), '*.txt diff=hostile\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'attrs');
    repo.git(
      'config',
      'diff.hostile.textconv',
      script('textconv.sh', `touch "${marks}/textconv"\ncat "$1"`),
    );
    rmSync(join(marks, 'fsmonitor'), { force: true }); // the setup commands above ran it
    return { repo, marks, seen: (n: string) => existsSync(join(marks, n)) };
  }

  it('is hostile when git is run the plain way (the test is meaningful)', () => {
    const { repo, marks, seen } = hostileRepo();
    gitSync(repo.path, 'status');
    gitSync(repo.path, 'worktree', 'add', join(marks, 'wt'), '-b', 'other');
    writeFileSync(join(repo.path, 'a.txt'), 'changed\n');
    gitSync(repo.path, 'diff'); // external diff
    repo.git('config', '--unset', 'diff.external');
    gitSync(repo.path, 'diff'); // textconv
    expect([seen('fsmonitor'), seen('hook'), seen('ext'), seen('textconv')]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('runs none of it through realGit, ensureWorktree and diffSince', async () => {
    const { repo, marks, seen } = hostileRepo();
    const wt = join(marks, 'safe-wt');
    expect((await realGit.run(['status', '--porcelain'], { cwd: repo.path })).code).toBe(0);
    const head = (await headCommit(realGit, repo.path)) as { commit: string };
    expect(await ensureWorktree(realGit, repo.path, wt, 'task/SAFE-1', false)).toMatchObject({
      ok: true,
    });
    writeFileSync(join(wt, 'a.txt'), 'changed in the worktree\n');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    const d = await diffSince(realGit, wt, head.commit);
    expect(d).toMatchObject({ ok: true });
    if (d.ok) expect(d.diff).toContain('+changed in the worktree');
    expect([seen('fsmonitor'), seen('hook'), seen('ext'), seen('textconv')]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('also with the external diff configured (diff run with the guard flags)', async () => {
    const { repo, marks, seen } = hostileRepo();
    repo.git('config', 'diff.external', join(marks, 'ext.sh'));
    writeFileSync(join(repo.path, 'a.txt'), 'edited\n');
    const head = (await headCommit(realGit, repo.path)) as { commit: string };
    const d = await diffSince(realGit, repo.path, head.commit);
    expect(d).toMatchObject({ ok: true });
    expect(seen('ext')).toBe(false);
    expect(seen('textconv')).toBe(false);
  });
});
