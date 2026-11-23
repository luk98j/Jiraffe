import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sources(pkg: string): { rel: string; text: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      if (n === 'node_modules' || n === 'dist') return [];
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(n) ? [full] : [];
    });
  return walk(join(ROOT, 'packages', pkg, 'src')).map((f) => ({
    rel: relative(ROOT, f),
    text: readFileSync(f, 'utf8'),
  }));
}
const all = ['adapters', 'core', 'db', 'engine', 'jira', 'server', 'web'].flatMap(sources);

describe('no push and no unrestricted mode (AC-89, AC-17)', () => {
  it('mentions `git push` only in the allowlist deny rules', () => {
    expect(all.filter((f) => /git\s+push/i.test(f.text)).map((f) => f.rel)).toEqual([
      'packages/adapters/src/allowlist.ts',
    ]);
  });

  it('mentions --yolo only in the allowlist deny rules', () => {
    expect(all.filter((f) => /--yolo/i.test(f.text)).map((f) => f.rel)).toEqual([
      'packages/adapters/src/allowlist.ts',
    ]);
  });

  it('runs no git subcommand that publishes or merges', () => {
    const bad = all.filter(
      (f) =>
        f.rel !== 'packages/adapters/src/allowlist.ts' && // the deny rules name "push"
        /['"`](push|merge|rebase|pull|fetch|clone|remote)['"`]/.test(f.text),
    );
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});

describe('the app never writes to Jira (AC-89)', () => {
  it('the Jira client interface has read methods only', () => {
    const text = readFileSync(join(ROOT, 'packages/jira/src/types.ts'), 'utf8');
    const body = /export interface JiraClient \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
    const names = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(['getComments', 'getIssues', 'searchPage']);
  });

  it('no source file sends a write request', () => {
    const bad = all.filter((f) => /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});
