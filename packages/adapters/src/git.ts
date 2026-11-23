import { spawn } from 'node:child_process';

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
        child = spawn('git', [...args], {
          cwd: o.cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
