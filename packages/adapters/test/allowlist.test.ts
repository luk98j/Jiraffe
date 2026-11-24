import { describe, expect, it } from 'vitest';
import { matchesAllowEntry, validateAllowedTools } from '../src/index.ts';

const ok = (...t: string[]) => validateAllowedTools(t);

describe('validateAllowedTools (AC-58)', () => {
  it('accepts the default list', () => {
    expect(ok('git status', 'git diff', 'git add', 'git commit', 'gradle test')).toEqual({
      ok: true,
    });
  });

  it('rejects an empty list and empty entries', () => {
    expect(ok()).toMatchObject({ ok: false });
    expect(ok('git status', '  ')).toMatchObject({ ok: false });
  });

  it.each([
    'git push',
    'git push origin main',
    'git  push',
    'git\tpush',
    'GIT PUSH',
    'git -C x push',
    'git --git-dir=.git push',
    'git -c user.name=x push',
    '/usr/bin/git push',
    'a && git push',
    'git status; git push',
    'git status | git push',
    '$(git push)',
    '`git push`',
    'git "push"',
    "'git' 'push'",
    'git pu\\sh',
    'git p"ush"',
    'FOO=1 git push',
    'git-push',
  ])('rejects a push in any form: %s', (entry) => {
    const r = ok('git status', entry);
    expect(r).toMatchObject({ ok: false });
  });

  it.each(['--yolo', 'git status --yolo', '--allow-all-tools', '--allow-all', 'allow-all'])(
    'rejects allow-all entries: %s',
    (entry) => {
      expect(ok(entry)).toMatchObject({ ok: false });
    },
  );

  it.each(['*', '**', '.*', 'all', 'ANY', 'everything', '?'])(
    'rejects the blanket entry %s',
    (entry) => {
      expect(ok(entry)).toMatchObject({ ok: false });
    },
  );

  it('rejects bare git and git with a wildcard, which would allow push', () => {
    expect(ok('git')).toMatchObject({ ok: false });
    expect(ok('git *')).toMatchObject({ ok: false });
  });

  it('does not reject unrelated words that merely contain "push"', () => {
    expect(ok('gradle pushTask')).toEqual({ ok: true });
    expect(ok('npm run pushover')).toEqual({ ok: true });
  });
});

describe('matchesAllowEntry (AC-59)', () => {
  it('matches at token boundaries', () => {
    expect(matchesAllowEntry('git status', 'git status')).toBe(true);
    expect(matchesAllowEntry('git status', 'git status -s')).toBe(true);
    expect(matchesAllowEntry('git status', '  git   status ')).toBe(true);
    expect(matchesAllowEntry('git status', 'git statusx')).toBe(false);
    expect(matchesAllowEntry('git status', 'xgit status')).toBe(false);
    expect(matchesAllowEntry('git status', 'git')).toBe(false);
  });

  it('refuses commands with shell control characters', () => {
    for (const c of [
      'git status; rm -rf x',
      'git status && rm x',
      'git status | cat',
      'git status > f',
      'git status $(x)',
      'git status `x`',
      'git status\nrm x',
    ])
      expect(matchesAllowEntry('git status', c), c).toBe(false);
  });

  it('never matches an empty entry', () => {
    expect(matchesAllowEntry('', 'git status')).toBe(false);
  });
});
