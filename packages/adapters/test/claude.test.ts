import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeProfile, createClaudeRunner } from '../src/index.ts';
import { stubSpawner } from '../src/testing.ts';
import { testOnlyClaudeProfile } from './claude-profile.ts';

const NOT_VERIFIED = 'Claude Code adapter is not verified';
const base = { maxCredits: 2 };

describe('Claude capability profile (AC-80)', () => {
  it('has every entry UNVERIFIED with a note, and no flag text at all', () => {
    for (const [name, e] of Object.entries(claudeProfile)) {
      expect(e.status, name).toBe('unverified');
      expect(e.note.length, name).toBeGreaterThan(0);
      expect('args' in e, name).toBe(false);
      expect(e.note, name).not.toMatch(/--/);
    }
  });
});

describe('Claude adapter fails closed (AC-80)', () => {
  it('does not spawn and reports that it is not verified', async () => {
    const spawner = stubSpawner();
    const runner = createClaudeRunner(spawner);
    expect(runner.id).toBe('claude');
    const r = await runner.start('go', '/w', { ...base, timeoutMs: 1000, onOutput() {} }).result;
    expect(spawner.spawns).toEqual([]);
    expect(r.spawnError).toBe(NOT_VERIFIED);
  });

  it('refuses both kinds of run in preflight with the same reason', () => {
    const runner = createClaudeRunner(stubSpawner());
    expect(runner.preflight('analysis', {})).toEqual({ ok: false, reason: NOT_VERIFIED });
    expect(runner.preflight('execution', { allowedTools: ['git status'] })).toEqual({
      ok: false,
      reason: NOT_VERIFIED,
    });
  });
});

describe('buildClaudeArgs with a test-only confirmed profile (AC-79)', () => {
  it('emits exactly the confirmed entries', () => {
    expect(
      buildClaudeArgs(
        'hi',
        { ...base, model: 'm1', allowedTools: ['git status'] },
        testOnlyClaudeProfile,
      ),
    ).toEqual({
      args: [
        '--test-prompt',
        'hi',
        '--test-budget',
        '2',
        '--test-model=m1',
        '--test-allow',
        'git status',
      ],
    });
  });

  it('omits optional entries that were not asked for', () => {
    expect(buildClaudeArgs('hi', base, testOnlyClaudeProfile)).toEqual({
      args: ['--test-prompt', 'hi', '--test-budget', '2'],
    });
  });

  it('refuses an allowlist while the allow-tool entry is unverified', () => {
    const profile = { ...testOnlyClaudeProfile, allowTool: claudeProfile.allowTool };
    expect(
      buildClaudeArgs('hi', { ...base, allowedTools: ['git status'] }, profile),
    ).toHaveProperty('error');
  });

  it('refuses a denied allowlist even when the entry is confirmed', () => {
    for (const bad of [['git push'], ['--yolo'], ['*'], []])
      expect(
        buildClaudeArgs('hi', { ...base, allowedTools: bad }, testOnlyClaudeProfile),
      ).toHaveProperty('error');
  });

  it('never emits yolo, a skip-permissions flag or an allow-all flag, whatever the options say', () => {
    const hostile: Record<string, unknown>[] = [
      {
        ...base,
        yolo: true,
        skipPermissions: true,
        dangerouslySkipPermissions: true,
        allowAll: true,
      },
      { ...base, allowedTools: ['--yolo'] },
      { ...base, allowedTools: ['--dangerously-skip-permissions'] },
      { ...base, model: '--yolo' },
    ];
    for (const profile of [claudeProfile, testOnlyClaudeProfile])
      for (const o of hostile) {
        const r = buildClaudeArgs('p', o as never, profile);
        const argv = 'args' in r ? r.args.join(' ') : '';
        expect(argv).not.toMatch(/yolo|skip|allow-all|dangerous/i);
      }
  });

  it('spawns `claude` with the built args and the given cwd', async () => {
    const spawner = stubSpawner({ lines: [{ stream: 'stdout', text: 'ok' }] });
    const lines: string[] = [];
    await createClaudeRunner(spawner, testOnlyClaudeProfile).start('go', '/repo', {
      ...base,
      timeoutMs: 1000,
      onOutput: (l) => lines.push(l.text),
    }).result;
    expect(spawner.spawns).toEqual([
      { cmd: 'claude', args: ['--test-prompt', 'go', '--test-budget', '2'], cwd: '/repo' },
    ]);
    expect(lines).toEqual(['ok']);
  });

  it('a missing binary reports "claude not found"', async () => {
    const spawner = stubSpawner({ error: { code: 'ENOENT', message: 'x' } });
    const r = await createClaudeRunner(spawner, testOnlyClaudeProfile).start('go', '/w', {
      ...base,
      timeoutMs: 1000,
      onOutput() {},
    }).result;
    expect(r.spawnError).toBe('claude not found');
  });
});
