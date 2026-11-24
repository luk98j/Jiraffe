import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInside, resolveWorktreePath } from '../src/index.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jiraffe-paths-')));

describe('resolveWorktreePath (AC-42, AC-43)', () => {
  it('resolves a relative directory against the repository', () => {
    const repo = join(tmp(), 'repo');
    mkdirSync(repo);
    expect(resolveWorktreePath(repo, '../.worktrees', 'PROJ-1')).toEqual({
      ok: true,
      path: join(repo, '..', '.worktrees', 'PROJ-1').replace(/\/repo\/\.\.\//, '/'),
    });
  });

  it('accepts an absolute directory', () => {
    const repo = tmp();
    const dir = tmp();
    expect(resolveWorktreePath(repo, dir, 'LOC-0001')).toEqual({
      ok: true,
      path: join(dir, 'LOC-0001'),
    });
  });

  it('refuses a path that is the repository or lies inside .git', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    expect(resolveWorktreePath(repo, '..', basename(repo))).toMatchObject({ ok: false });
    expect(resolveWorktreePath(repo, '.git', 'x')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/\.git/),
    });
    expect(resolveWorktreePath(repo, '.git/worktrees', 'x')).toMatchObject({ ok: false });
  });

  it.each(['a/b', '..', '../x', 'a b', 'a;b', 'a$(x)', '', 'ä', 'a\nb', '-rf'.replace('-', '/')])(
    'refuses the key %j',
    (key) => {
      expect(resolveWorktreePath(tmp(), 'w', key)).toMatchObject({ ok: false });
    },
  );

  it('follows a symlinked worktrees directory into .git and refuses it', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    symlinkSync(join(repo, '.git'), join(repo, 'link'));
    expect(resolveWorktreePath(repo, 'link', 'x')).toMatchObject({ ok: false });
  });
});

function basename(p: string) {
  return p.split('/').pop() as string;
}

describe('resolveInside (AC-60)', () => {
  it('accepts a path under the root, also when it does not exist yet', () => {
    const root = tmp();
    expect(resolveInside(root, '.orchestrator/context.md')).toBe(
      join(root, '.orchestrator/context.md'),
    );
  });

  it('refuses .. escapes and absolute paths elsewhere', () => {
    const root = tmp();
    expect(resolveInside(root, '../x')).toBeUndefined();
    expect(resolveInside(root, 'a/../../x')).toBeUndefined();
    expect(resolveInside(root, tmp())).toBeUndefined();
  });

  it('refuses a symlink that points outside', () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, 'out'));
    expect(resolveInside(root, 'out/file')).toBeUndefined();
  });
});
