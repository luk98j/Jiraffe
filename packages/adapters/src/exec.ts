import { failedStart, type OutputLine, type RunHandle, type RunOutcome } from './runner.ts';
import type { ChildLike, Spawner } from './spawner.ts';

const GRACE_MS = 5000;
const MAX_LINE = 64 * 1024;

/** Splits a stream into lines; a partial line is held back, or cut at MAX_LINE. */
function lineSplitter(emit: (text: string) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        emit(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
      while (buf.length > MAX_LINE) {
        emit(buf.slice(0, MAX_LINE));
        buf = buf.slice(MAX_LINE);
      }
    },
    end() {
      if (buf) emit(buf.replace(/\r$/, ''));
      buf = '';
    },
  };
}

/**
 * Runs one command with a timeout, ordered output lines and a kill that escalates from
 * SIGTERM to SIGKILL. Shared by every CLI adapter.
 */
export function runCommand(
  spawner: Spawner,
  cmd: string,
  args: readonly string[],
  o: {
    cwd: string;
    timeoutMs: number;
    onOutput: (l: OutputLine) => void;
    graceMs?: number;
  },
): RunHandle {
  const grace = o.graceMs ?? GRACE_MS;
  let child: ChildLike;
  try {
    child = spawner.spawn(cmd, args, { cwd: o.cwd });
  } catch (err) {
    return failedStart(err instanceof Error ? err.message : `${cmd} could not be started`);
  }

  let timedOut = false;
  let cancelled = false;
  let exited = false;
  let resolveResult!: (r: RunOutcome) => void;
  const result = new Promise<RunOutcome>((r) => {
    resolveResult = r;
  });
  const timers: ReturnType<typeof setTimeout>[] = [];

  const out = lineSplitter((text) => o.onOutput({ stream: 'stdout', text }));
  const err = lineSplitter((text) => o.onOutput({ stream: 'stderr', text }));
  child.onStdout((c) => out.push(c));
  child.onStderr((c) => err.push(c));

  const settle = (r: Omit<RunOutcome, 'timedOut' | 'cancelled'>) => {
    if (exited) return;
    exited = true;
    for (const t of timers) clearTimeout(t);
    out.end();
    err.end();
    resolveResult({ ...r, timedOut, cancelled });
  };

  const stop = () => {
    if (exited) return;
    child.kill('SIGTERM');
    timers.push(setTimeout(() => !exited && child.kill('SIGKILL'), grace));
  };

  child.onError((e) =>
    settle({
      exitCode: null,
      signal: null,
      spawnError: e.code === 'ENOENT' ? `${cmd} not found` : e.message,
    }),
  );
  child.onExit((code, signal) => settle({ exitCode: code, signal }));

  timers.push(
    setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs),
  );

  return {
    pid: child.pid,
    result,
    async cancel() {
      if (!exited) {
        cancelled = true;
        stop();
      }
      await result;
    },
  };
}
