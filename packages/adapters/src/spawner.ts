import { spawn } from 'node:child_process';

export type KillSignal = 'SIGTERM' | 'SIGKILL';

export interface ChildLike {
  pid: number | undefined;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (err: Error & { code?: string }) => void): void;
  kill(signal: KillSignal): void;
}

export interface Spawner {
  spawn(cmd: string, args: readonly string[], o: { cwd: string }): ChildLike;
}

/**
 * The only place a process is spawned. Argument arrays, never a shell. The child leads its
 * own process group so a kill reaches its children too. POSIX only.
 */
export const nodeSpawner: Spawner = {
  spawn(cmd, args, o) {
    const child = spawn(cmd, [...args], {
      cwd: o.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    return {
      pid: child.pid,
      onStdout: (cb) => child.stdout.on('data', cb),
      onStderr: (cb) => child.stderr.on('data', cb),
      onExit: (cb) => child.on('close', cb),
      onError: (cb) => child.on('error', cb),
      kill(signal) {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      },
    };
  },
};
