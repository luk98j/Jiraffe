import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { GitRunner } from './git.ts';
import { resolveInside } from './paths.ts';

export const DIFF_CAP = 1024 * 1024;
const SHA = /^[0-9a-f]{7,64}$/;

export type Done<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (
  what: string,
  r: { stderr: string; stdout: string },
): { ok: false; error: string } => ({
  ok: false,
  error: `${what}: ${(r.stderr || r.stdout).trim().slice(-1000) || 'git failed'}`,
});

export async function headCommit(git: GitRunner, repo: string): Promise<Done<{ commit: string }>> {
  const r = await git.run(['rev-parse', 'HEAD'], { cwd: repo });
  const commit = r.stdout.trim();
  return r.code === 0 && SHA.test(commit) ? { ok: true, commit } : fail('Cannot read HEAD', r);
}

const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

/**
 * Creates the worktree on `branch`, or reuses what exists (a retry). Never forces,
 * never resets a branch, so earlier commits survive.
 */
export async function ensureWorktree(
  git: GitRunner,
  repo: string,
  path: string,
  branch: string,
): Promise<Done> {
  const list = await git.run(['worktree', 'list', '--porcelain'], { cwd: repo });
  if (list.code !== 0) return fail('Cannot list worktrees', list);
  const registered = list.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
  if (registered.some((w) => samePath(w, path)) && existsSync(path)) return { ok: true };
  const exists = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repo,
  });
  const args =
    exists.code === 0 ? ['worktree', 'add', path, branch] : ['worktree', 'add', path, '-b', branch];
  const r = await git.run(args, { cwd: repo });
  return r.code === 0 ? { ok: true } : fail('git worktree add failed', r);
}

/** Writes a file inside the worktree only, creating folders. */
export function writeInside(root: string, rel: string, text: string): Done {
  const full = resolveInside(root, rel);
  if (!full) return { ok: false, error: `Path ${rel} is outside the worktree` };
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return { ok: true };
}

/** Adds `.orchestrator/` to the exclude file git reports for this worktree (correct for linked worktrees). */
export async function addInfoExclude(git: GitRunner, worktree: string): Promise<Done> {
  const r = await git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree });
  const rel = r.stdout.trim();
  if (r.code !== 0 || !rel) return fail('Cannot find the exclude file', r);
  // The one explicit exception to "inside the worktree": git decides where this file lives.
  const file = isAbsolute(rel) ? rel : join(worktree, rel);
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!current.split('\n').includes('.orchestrator/'))
    appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}.orchestrator/\n`);
  return { ok: true };
}

/** Diff of everything (also new files) against `base`, capped at DIFF_CAP with a visible marker. */
export async function diffSince(
  git: GitRunner,
  worktree: string,
  base: string,
): Promise<Done<{ diff: string; truncated: boolean }>> {
  if (!SHA.test(base)) return { ok: false, error: 'Invalid base commit' };
  // Records new files without staging their content, so `git diff` shows them.
  const add = await git.run(['add', '--intent-to-add', '-A'], { cwd: worktree });
  if (add.code !== 0) return fail('git add failed', add);
  const r = await git.run(['diff', base], { cwd: worktree, maxBytes: DIFF_CAP });
  if (r.code !== 0) return fail('git diff failed', r);
  return {
    ok: true,
    truncated: r.truncated,
    diff: r.truncated ? `${r.stdout}\n[diff truncated at 1 MiB]\n` : r.stdout,
  };
}

export async function removeWorktree(git: GitRunner, repo: string, path: string): Promise<Done> {
  const r = await git.run(['worktree', 'remove', path], { cwd: repo });
  return r.code === 0 ? { ok: true } : fail('git worktree remove failed', r);
}

export async function deleteBranch(git: GitRunner, repo: string, branch: string): Promise<Done> {
  const r = await git.run(['branch', '-D', branch], { cwd: repo });
  return r.code === 0 ? { ok: true } : fail('git branch -D failed', r);
}
