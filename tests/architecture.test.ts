import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['adapters', 'core', 'db', 'engine', 'jira', 'server', 'web'] as const;

// Allowed workspace imports (AC-3).
const ALLOWED: Record<string, string[]> = {
  adapters: ['core'],
  core: [],
  db: ['core'],
  jira: ['core'],
  engine: ['core', 'db', 'jira', 'adapters'],
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

interface Import {
  pkg: string;
  file: string;
  spec: string;
}
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
  it('has exactly the seven packages and core has no workspace dependency', () => {
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

  it('only adapters imports node:child_process', () => {
    const violations = allImports().filter(
      (i) =>
        (i.spec === 'node:child_process' || i.spec === 'child_process') && i.pkg !== 'adapters',
    );
    expect(violations).toEqual([]);
  });

  it('no relative import leaves its package directory', () => {
    const violations = allImports().filter((i) => {
      if (!i.spec.startsWith('.')) return false;
      const target = resolve(dirname(join(ROOT, i.file)), i.spec);
      return !target.startsWith(`${join(ROOT, 'packages', i.pkg)}/`);
    });
    expect(violations).toEqual([]);
  });
});

describe('only the engine writes task status (AC-22)', () => {
  const srcFiles = PACKAGES.flatMap((pkg) => {
    try {
      return walk(join(ROOT, 'packages', pkg, 'src'));
    } catch {
      return [];
    }
  }).map((f) => ({ rel: relative(ROOT, f), text: readFileSync(f, 'utf8') }));
  const WRITER = 'packages/db/src/taskStatus.ts';

  it('imports @jiraffe/db/status-writer only from transition.ts and createTask.ts', () => {
    const users = srcFiles
      .filter((f) => f.rel !== WRITER && f.text.includes('@jiraffe/db/status-writer'))
      .map((f) => f.rel);
    expect(users.sort()).toEqual([
      'packages/engine/src/createTask.ts',
      'packages/engine/src/transition.ts',
    ]);
  });

  it('has no UPDATE tasks or insert(tasks) outside the status writer', () => {
    const bad = srcFiles.filter(
      (f) =>
        f.rel !== WRITER &&
        (/UPDATE\s+tasks/i.test(f.text) || /insert\(\s*tasks\s*\)/.test(f.text)),
    );
    expect(bad.map((f) => f.rel)).toEqual([]);
  });

  it('has no .set({...}) touching status columns outside the status writer', () => {
    const bad = srcFiles.filter(
      (f) =>
        f.rel !== WRITER &&
        /\.set\(\s*\{[^}]*\b(status|statusBeforePause|pauseReason|resumeAt)\b/.test(f.text),
    );
    expect(bad.map((f) => f.rel)).toEqual([]);
  });

  it('exports exactly insertTask and applyStatusChange from the status writer', () => {
    const text = srcFiles.find((f) => f.rel === WRITER)!.text;
    const names = [...text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(['applyStatusChange', 'insertTask']);
  });
});

describe('English only (AC-76)', () => {
  // Polish diacritics written as escapes so this file stays free of them.
  const POLISH = new RegExp(
    '[' +
      [
        0x105, 0x107, 0x119, 0x142, 0x144, 0xf3, 0x15b, 0x17a, 0x17c, 0x104, 0x106, 0x118, 0x141,
        0x143, 0xd3, 0x15a, 0x179, 0x17b,
      ]
        .map((c) => String.fromCharCode(c))
        .join('') +
      ']',
  );
  const SKIP = new Set([
    'node_modules',
    'dist',
    '.git',
    'data',
    'runs',
    'memory',
    '.DS_Store',
    'pnpm-lock.yaml',
    'coverage',
  ]);

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }

  it('has no Polish diacritics in any project file', () => {
    const hits = files(ROOT)
      .filter((f) => !/\.(png|jpe?g|gif|ico|db|woff2?)$/i.test(f))
      .filter((f) => POLISH.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
