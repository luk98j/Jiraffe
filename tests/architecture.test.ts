import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['core', 'db', 'engine', 'jira', 'server', 'web'] as const;

// Allowed workspace imports (AC-3). `adapters` joins this table in a later step.
const ALLOWED: Record<string, string[]> = {
  core: [],
  db: ['core'],
  jira: ['core'],
  engine: ['core', 'db', 'jira'],
  server: ['core', 'engine'],
  web: ['core'],
};

// External packages only one workspace package may import.
const OWNERS: Record<string, string> = {
  'drizzle-orm': 'db',
  'better-sqlite3': 'db',
  fastify: 'server',
  react: 'web',
  'react-dom': 'web',
};

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function specifiers(source: string): string[] {
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1] as string);
}

interface Import { pkg: string; file: string; spec: string }
function allImports(): Import[] {
  const result: Import[] = [];
  for (const pkg of PACKAGES) {
    const base = join(ROOT, 'packages', pkg);
    for (const dir of ['src', 'test']) {
      try {
        statSync(join(base, dir));
      } catch {
        continue;
      }
      for (const file of walk(join(base, dir))) {
        for (const spec of specifiers(readFileSync(file, 'utf8'))) {
          result.push({ pkg, file: relative(ROOT, file), spec });
        }
      }
    }
  }
  return result;
}

const rootOf = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string);

describe('workspace layout (AC-2)', () => {
  it('has exactly the six packages and core has no workspace dependency', () => {
    expect(readdirSync(join(ROOT, 'packages')).sort()).toEqual([...PACKAGES].sort());
    for (const pkg of PACKAGES) {
      const json = JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'));
      expect(json.name).toBe(`@jiraffe/${pkg}`);
    }
    const core = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
    const all = { ...core.dependencies, ...core.devDependencies, ...core.peerDependencies };
    expect(Object.keys(all).filter((n) => n.startsWith('@jiraffe/'))).toEqual([]);
  });
});

describe('dependency rules (AC-3)', () => {
  it('manifests declare only allowed workspace dependencies', () => {
    for (const pkg of PACKAGES) {
      const json = JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'));
      const declared = Object.keys({ ...json.dependencies, ...json.devDependencies })
        .filter((n) => n.startsWith('@jiraffe/'))
        .map((n) => n.slice('@jiraffe/'.length))
        .sort();
      expect(declared, pkg).toEqual([...ALLOWED[pkg]!].sort());
    }
  });

  it('source imports only allowed workspace packages', () => {
    const violations = allImports().filter((i) => {
      if (!i.spec.startsWith('@jiraffe/')) return false;
      const target = rootOf(i.spec).slice('@jiraffe/'.length);
      return target !== i.pkg && !ALLOWED[i.pkg]!.includes(target);
    });
    expect(violations).toEqual([]);
  });

  it('only the owning package imports db, server and UI libraries', () => {
    const violations = allImports().filter((i) => {
      const owner = OWNERS[rootOf(i.spec)];
      return owner !== undefined && owner !== i.pkg;
    });
    expect(violations).toEqual([]);
  });

  it('no relative import leaves its package directory', () => {
    const violations = allImports().filter((i) => {
      if (!i.spec.startsWith('.')) return false;
      const target = resolve(dirname(join(ROOT, i.file)), i.spec);
      return !target.startsWith(join(ROOT, 'packages', i.pkg) + '/');
    });
    expect(violations).toEqual([]);
  });
});
