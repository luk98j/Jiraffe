import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCopilotRunner,
  nodeSpawner,
  runCommand,
  type AgentRunner,
  type OutputLine,
  type RunOptions,
} from '../src/index.ts';
import { FakeRunner, stubSpawner, type StubScript, type StubSpawner } from '../src/testing.ts';

interface Made {
  runner: AgentRunner;
  spawner: StubSpawner;
}
const impls: [string, (s: StubScript) => Made][] = [
  [
    'FakeRunner',
    (s) => {
      const runner = new FakeRunner(s);
      return { runner, spawner: runner.spawner };
    },
  ],
  [
    'Copilot adapter on a stub spawner',
    (s) => {
      const spawner = stubSpawner(s);
      return { runner: createCopilotRunner(spawner), spawner };
    },
  ],
];

const opts = (lines: OutputLine[], over: Partial<RunOptions> = {}): RunOptions => ({
  maxCredits: 1,
  timeoutMs: 60_000,
  onOutput: (l) => lines.push(l),
  ...over,
});

describe.each(impls)('AgentRunner contract: %s (AC-13, AC-18..20)', (_name, make) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams ordered, stream-labelled lines and exits 0', async () => {
    const { runner } = make({
      lines: [
        { stream: 'stdout', text: 'one' },
        { stream: 'stderr', text: 'warn' },
        { stream: 'stdout', text: 'two' },
      ],
    });
    const seen: OutputLine[] = [];
    const h = runner.start('p', '/work', opts(seen));
    expect(h.pid).toBeTypeOf('number');
    const r = await h.result;
    expect(seen).toEqual([
      { stream: 'stdout', text: 'one' },
      { stream: 'stderr', text: 'warn' },
      { stream: 'stdout', text: 'two' },
    ]);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(r.spawnError).toBeUndefined();
  });

  it('joins partial chunks into lines and flushes the last partial line', async () => {
    const { runner } = make({
      chunks: [
        { stream: 'stdout', text: 'ab' },
        { stream: 'stdout', text: 'c\r\nde' },
      ],
    });
    const seen: OutputLine[] = [];
    await runner.start('p', '/w', opts(seen)).result;
    expect(seen.map((l) => l.text)).toEqual(['abc', 'de']);
  });

  it('reports a non-zero exit code', async () => {
    const { runner } = make({ exitCode: 3, lines: [{ stream: 'stderr', text: 'boom' }] });
    expect(await runner.start('p', '/w', opts([])).result).toMatchObject({ exitCode: 3 });
  });

  it('maps a missing binary to spawnError', async () => {
    const { runner } = make({ error: { code: 'ENOENT', message: 'spawn x ENOENT' } });
    const r = await runner.start('p', '/w', opts([])).result;
    expect(r.spawnError).toMatch(/not found/);
    expect(r.exitCode).toBeNull();
  });

  it('kills a hanging run on timeout (SIGTERM, then SIGKILL) and marks timedOut', async () => {
    const { runner, spawner } = make({ hang: true, ignoreSigterm: true });
    const p = runner.start('p', '/w', opts([], { timeoutMs: 1000 })).result;
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawner.kills.map((k) => k.signal)).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawner.kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await p).toMatchObject({ timedOut: true, cancelled: false });
  });

  it('cancel() kills the run and resolves with cancelled', async () => {
    const { runner, spawner } = make({ hang: true });
    const h = runner.start('p', '/w', opts([]));
    await h.cancel();
    expect(spawner.kills[0]).toMatchObject({ signal: 'SIGTERM' });
    expect(await h.result).toMatchObject({ cancelled: true, timedOut: false });
  });

  it('cancel() after the run finished is harmless', async () => {
    const { runner, spawner } = make({});
    const h = runner.start('p', '/w', opts([]));
    await h.result;
    await h.cancel();
    expect(spawner.kills).toEqual([]);
  });

  it('never throws from start', () => {
    const { runner } = make({});
    expect(() => runner.start('p', '/w', opts([], { maxCredits: Number.NaN }))).not.toThrow();
  });
});

describe('process group kill with a real process (AC-19)', () => {
  it.skipIf(process.platform === 'win32')(
    'cancel() kills the child and its children',
    async () => {
      const script = `
        const { spawn } = require('node:child_process');
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log('child ' + c.pid);
        setInterval(() => {}, 1000);`;
      const lines: OutputLine[] = [];
      const h = runCommand(nodeSpawner, process.execPath, ['-e', script], {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        onOutput: (l) => lines.push(l),
        graceMs: 1000,
      });
      for (let i = 0; i < 200 && !lines.some((l) => l.text.startsWith('child ')); i++)
        await new Promise((r) => setTimeout(r, 25));
      const grandchild = Number(lines.find((l) => l.text.startsWith('child '))?.text.slice(6));
      expect(grandchild).toBeGreaterThan(0);
      await h.cancel();
      expect((await h.result).cancelled).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
    },
    15_000,
  );
});
