import type { Verdict } from '@jiraffe/core';
import { runCommand } from './exec.ts';
import type { GitResult, GitRunner } from './git.ts';
import type {
  AgentId,
  AgentRunner,
  OutputLine,
  Preflight,
  RunHandle,
  RunOptions,
} from './runner.ts';
import type { ChildLike, KillSignal, Spawner } from './spawner.ts';

/** What a scripted child does. Used by `stubSpawner` and `FakeRunner`. */
export interface StubScript {
  /** Lines written in order; a newline is added. */
  lines?: OutputLine[];
  /** Raw chunks written after `lines`, with no newline added. */
  chunks?: OutputLine[];
  exitCode?: number;
  /** Wait for this promise before exiting. */
  until?: Promise<unknown>;
  /** Run until killed. */
  hang?: boolean;
  /** SIGTERM is ignored, only SIGKILL ends the child. */
  ignoreSigterm?: boolean;
  /** Emit a spawn error instead of running (for example `{ code: 'ENOENT' }`). */
  error?: { code?: string; message: string };
  pid?: number;
}

export interface StubSpawner extends Spawner {
  spawns: { cmd: string; args: readonly string[]; cwd: string }[];
  kills: { pid: number | undefined; signal: KillSignal }[];
}

/** A spawner that never starts a process. */
export function stubSpawner(script: StubScript | (() => StubScript) = {}): StubSpawner {
  const spawns: StubSpawner['spawns'] = [];
  const kills: StubSpawner['kills'] = [];
  return {
    spawns,
    kills,
    spawn(cmd, args, o): ChildLike {
      spawns.push({ cmd, args, cwd: o.cwd });
      const s = typeof script === 'function' ? script() : script;
      const h = {
        out: (_: string) => {},
        err: (_: string) => {},
        exit: (_c: number | null, _s: string | null) => {},
        error: (_e: Error & { code?: string }) => {},
      };
      let ended = false;
      const end = (code: number | null, signal: string | null) => {
        if (ended) return;
        ended = true;
        h.exit(code, signal);
      };
      let release: () => void = () => {};
      const killed = new Promise<void>((r) => {
        release = r;
      });
      const child: ChildLike = {
        pid: s.pid ?? 4242,
        onStdout: (cb) => {
          h.out = cb;
        },
        onStderr: (cb) => {
          h.err = cb;
        },
        onExit: (cb) => {
          h.exit = cb;
        },
        onError: (cb) => {
          h.error = cb;
        },
        kill(signal) {
          kills.push({ pid: child.pid, signal });
          if (s.ignoreSigterm && signal === 'SIGTERM') return;
          end(null, signal);
          release();
        },
      };
      queueMicrotask(async () => {
        if (s.error) return h.error(Object.assign(new Error(s.error.message), s.error));
        const emit = (l: OutputLine, nl: string) =>
          (l.stream === 'stdout' ? h.out : h.err)(l.text + nl);
        for (const l of s.lines ?? []) emit(l, '\n');
        for (const c of s.chunks ?? []) emit(c, '');
        if (s.hang) await killed;
        else if (s.until) await Promise.race([s.until, killed]);
        end(s.exitCode ?? 0, null);
      });
      return child;
    },
  };
}

export interface FakeCall {
  prompt: string;
  cwd: string;
  options: RunOptions;
}

type ScriptFn = (call: FakeCall, n: number) => StubScript;

/**
 * A scriptable runner for tests. It runs the same process-control code as the real
 * adapters (timeout, cancel, line framing) against a stub spawner, so no CLI is needed.
 */
export class FakeRunner implements AgentRunner {
  id: AgentId = 'copilot';
  calls: FakeCall[] = [];
  spawner: StubSpawner;
  /** Called at the moment of `start`, before anything runs. */
  onStart?: (call: FakeCall) => void;
  preflightResult: Preflight = { ok: true };
  private nextScript: StubScript | ScriptFn;
  private current: StubScript = {};

  constructor(script: StubScript | ScriptFn = {}) {
    this.nextScript = script;
    this.spawner = stubSpawner(() => this.current);
  }

  setScript(script: StubScript | ScriptFn): void {
    this.nextScript = script;
  }

  preflight(): Preflight {
    return this.preflightResult;
  }

  start(prompt: string, cwd: string, options: RunOptions): RunHandle {
    const call: FakeCall = { prompt, cwd, options };
    this.calls.push(call);
    this.onStart?.(call);
    this.current =
      typeof this.nextScript === 'function'
        ? this.nextScript(call, this.calls.length)
        : this.nextScript;
    return runCommand(this.spawner, 'fake-agent', [], {
      cwd,
      timeoutMs: options.timeoutMs,
      onOutput: options.onOutput,
      graceMs: 50,
    });
  }
}

/** The fenced JSON block an analysis agent ends its answer with. */
export function verdictBlock(v: Partial<Verdict> = {}): string {
  const verdict: Verdict = {
    verdict: 'READY',
    questions: [],
    missing: [],
    permissions: [],
    summary: 'ok',
    ...v,
  };
  return `\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
}

/** Records every git call; `respond` decides the result (default: exit 0, no output). */
export class FakeGit implements GitRunner {
  calls: { args: readonly string[]; cwd: string }[] = [];
  constructor(
    private respond: (
      args: readonly string[],
      cwd: string,
      n: number,
    ) => Partial<GitResult> = () => ({}),
  ) {}

  async run(args: readonly string[], o: { cwd: string }): Promise<GitResult> {
    this.calls.push({ args, cwd: o.cwd });
    return {
      code: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      ...this.respond(args, o.cwd, this.calls.length),
    };
  }
}
