import { spawn } from 'node:child_process';
import { childEnv } from './spawner.ts';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Output was cut at `maxBytes`. */
  truncated: boolean;
}

/** Every git call goes through this interface: argument arrays only, never a shell string. */
export interface GitRunner {
  run(args: readonly string[], o: { cwd: string; maxBytes?: number }): Promise<GitResult>;
}

/**
 * Git runs in repositories an agent may have written to, so config in `.git` is not trusted.
 * The program-launching settings that every subcommand used here reads are turned off.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/** No Jira credentials, no inherited GIT_* variables, no system config, never a prompt. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = childEnv(env);
  for (const k of Object.keys(out)) if (k.startsWith('GIT_')) delete out[k];
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export const realGit: GitRunner = {
  run(args, o) {
    const max = o.maxBytes ?? DEFAULT_MAX_BYTES;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, truncated });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', [...SAFE_CONFIG, ...args], {
          cwd: o.cwd,
          env: gitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        stderr = err instanceof Error ? err.message : 'git could not be started';
        return resolve({ code: null, stdout, stderr, truncated });
      }
      const timer = setTimeout(() => {
        stderr += 'git timed out';
        child.kill('SIGKILL');
      }, GIT_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        if (stdout.length + c.length > max) {
          stdout += c.slice(0, Math.max(0, max - stdout.length));
          truncated = true;
        } else stdout += c;
      });
      child.stderr?.on('data', (c: string) => {
        if (stderr.length < 8192) stderr += c;
      });
      child.on('error', (e) => {
        stderr += e.message;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  },
};
