import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Keys become a directory and a branch name, so only these characters are allowed. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** realpath of the deepest existing ancestor, with the missing rest appended. */
function realDeepest(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

const isInside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * `<worktrees_dir>/<KEY>`, resolved against the repository when relative. Refused when the
 * key has odd characters, or the result is the repository itself or inside its `.git`.
 */
export function resolveWorktreePath(
  repoPath: string,
  worktreesDir: string,
  key: string,
): PathResult {
  if (!KEY_PATTERN.test(key))
    return { ok: false, reason: `Task key "${key}" is not safe for a path` };
  const repo = realDeepest(repoPath);
  const base = isAbsolute(worktreesDir) ? worktreesDir : resolve(repoPath, worktreesDir);
  const path = realDeepest(join(base, key));
  if (path === repo) return { ok: false, reason: 'The worktree path is the repository itself' };
  if (isInside(join(repo, '.git'), path))
    return { ok: false, reason: 'The worktree path is inside the .git directory' };
  return { ok: true, path };
}

/** The folder that holds every worktree: `worktrees_dir`, against the repository when relative. */
export function worktreesRoot(repoPath: string, worktreesDir: string): string {
  return realDeepest(isAbsolute(worktreesDir) ? worktreesDir : resolve(repoPath, worktreesDir));
}

/** `candidate` resolved through symlinks, or undefined when it leaves `root`. */
export function resolveInside(root: string, candidate: string): string | undefined {
  const base = realDeepest(root);
  const full = realDeepest(isAbsolute(candidate) ? candidate : join(root, candidate));
  return isInside(base, full) ? full : undefined;
}
