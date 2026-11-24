import { describe, expect, it } from 'vitest';
import {
  buildCopilotArgs,
  copilotProfile,
  createCopilotRunner,
  type CopilotProfile,
} from '../src/index.ts';
import { stubSpawner } from '../src/testing.ts';

const base = { maxCredits: 2 };

// A profile with a made-up flag marked confirmed. It exists only here, to prove the
// builder emits exactly the given tools and nothing wider. It is not a real Copilot flag.
const testOnlyProfile: CopilotProfile = {
  ...copilotProfile,
  allowTool: {
    status: 'confirmed',
    note: 'test only',
    args: (tools) => tools.flatMap((t) => ['--test-only-allow', t]),
  },
};

describe('buildCopilotArgs (AC-16, AC-17)', () => {
  it('emits only -p and --max-ai-credits by default', () => {
    expect(buildCopilotArgs('hello', base)).toEqual({
      args: ['-p', 'hello', '--max-ai-credits', '2'],
    });
  });

  it('adds --model= and --agent= only when given', () => {
    expect(buildCopilotArgs('x', { ...base, model: 'gpt-5', agentName: 'analyst' })).toEqual({
      args: ['-p', 'x', '--max-ai-credits', '2', '--model=gpt-5', '--agent=analyst'],
    });
  });

  it('keeps the prompt as one argument even with spaces, quotes, dashes and newlines', () => {
    const prompt = '--yolo "quoted" $(rm -rf /)\nline two';
    const r = buildCopilotArgs(prompt, base);
    expect(r).toEqual({ args: ['-p', prompt, '--max-ai-credits', '2'] });
  });

  it.each([
    ['zero credits', { maxCredits: 0 }],
    ['NaN credits', { maxCredits: Number.NaN }],
    ['negative credits', { maxCredits: -1 }],
    ['model that looks like a flag', { ...base, model: '--yolo' }],
    ['agent with a space', { ...base, agentName: 'a b' }],
    ['empty model', { ...base, model: '' }],
  ])('refuses %s', (_n, o) => {
    expect(buildCopilotArgs('p', o)).toHaveProperty('error');
  });

  it('never emits yolo, autopilot or allow-all, even for hostile options', () => {
    const hostile: Record<string, unknown>[] = [
      { ...base, yolo: true, autopilot: true, allowAll: true, 'allow-all-tools': true },
      { ...base, allowedTools: ['--yolo'] },
      { ...base, allowedTools: ['--allow-all-tools'] },
      { ...base, allowedTools: ['*'] },
      { ...base, allowedTools: ['git status', '--autopilot'] },
      { ...base, model: '--yolo' },
    ];
    for (const profile of [copilotProfile, testOnlyProfile]) {
      for (const o of hostile) {
        const r = buildCopilotArgs('p', o as never, profile);
        const argv = 'args' in r ? r.args.join(' ') : '';
        expect(argv).not.toMatch(/yolo|autopilot|allow-all/i);
      }
    }
  });

  it('refuses an allowlist while the allow-tool entry is UNVERIFIED (fail closed)', () => {
    const r = buildCopilotArgs('p', { ...base, allowedTools: ['git status'] });
    expect(r).toEqual({ error: expect.stringMatching(/not confirmed.*item 1/) });
  });

  it('refuses a denied allowlist even when the entry is confirmed (AC-58)', () => {
    for (const bad of [['git push'], ['git -C x push'], ['a && git push'], ['--yolo'], []]) {
      expect(buildCopilotArgs('p', { ...base, allowedTools: bad }, testOnlyProfile)).toHaveProperty(
        'error',
      );
    }
  });

  it('with a test-confirmed entry passes exactly the given tools and nothing else (AC-56)', () => {
    const tools = ['git status', 'gradle test'];
    expect(buildCopilotArgs('p', { ...base, allowedTools: tools }, testOnlyProfile)).toEqual({
      args: [
        '-p',
        'p',
        '--max-ai-credits',
        '2',
        '--test-only-allow',
        'git status',
        '--test-only-allow',
        'gradle test',
      ],
    });
  });
});

describe('createCopilotRunner', () => {
  it('spawns `copilot` with the built args and the given cwd', async () => {
    const spawner = stubSpawner({ lines: [{ stream: 'stdout', text: 'hi' }] });
    const lines: string[] = [];
    const h = createCopilotRunner(spawner).start('go', '/repo', {
      maxCredits: 1.5,
      model: 'm',
      timeoutMs: 1000,
      onOutput: (l) => lines.push(l.text),
    });
    await h.result;
    expect(spawner.spawns).toEqual([
      {
        cmd: 'copilot',
        args: ['-p', 'go', '--max-ai-credits', '1.5', '--model=m'],
        cwd: '/repo',
      },
    ]);
    expect(lines).toEqual(['hi']);
  });

  it('does not spawn when the arguments are refused', async () => {
    const spawner = stubSpawner();
    const r = await createCopilotRunner(spawner).start('go', '/r', {
      maxCredits: 1,
      allowedTools: ['git status'],
      timeoutMs: 1000,
      onOutput() {},
    }).result;
    expect(spawner.spawns).toEqual([]);
    expect(r.spawnError).toMatch(/not confirmed/);
  });

  it('preflight: analysis is fine, execution fails closed with the real profile', () => {
    const runner = createCopilotRunner(stubSpawner());
    expect(runner.preflight('analysis', {})).toEqual({ ok: true });
    const r = runner.preflight('execution', { allowedTools: ['git status'] });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('item 1') });
    expect(runner.preflight('execution', {})).toMatchObject({ ok: false });
  });

  it('preflight: execution passes only with a confirmed entry and a valid list', () => {
    const runner = createCopilotRunner(stubSpawner(), testOnlyProfile);
    expect(runner.preflight('execution', { allowedTools: ['git status'] })).toEqual({ ok: true });
    expect(runner.preflight('execution', { allowedTools: ['git push'] })).toMatchObject({
      ok: false,
    });
  });
});
