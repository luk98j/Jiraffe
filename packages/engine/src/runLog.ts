import type { OutputLine } from '@jiraffe/adapters';
import { insertEvent } from '@jiraffe/db';
import { write, type Ctx } from './context.ts';

export const LOG_CAP_BYTES = 5 * 1024 * 1024;
const TAIL_CAP = 256 * 1024;
const FLUSH_MS = 250;
const FLUSH_LINES = 50;

type Pending =
  | { type: 'agent_output'; payload: { runId: number } & OutputLine }
  | { type: 'log_truncated' };

/** Exact values of the Jira credentials, if set in this process. They must never be stored. */
function secrets(): string[] {
  return [process.env.JIRA_API_TOKEN, process.env.JIRA_EMAIL].filter((s): s is string => !!s);
}

/**
 * Batches agent output into `events` rows (type `agent_output`, inserted already processed so
 * the poller never scans them) and keeps a rolling tail for verdict parsing and error text.
 * Log text goes to `events` only, never to the journal.
 */
export class RunLog {
  private pending: Pending[] = [];
  private stored = 0;
  private truncated = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tails = { stdout: '', stderr: '' };
  private secrets = secrets();

  constructor(
    private ctx: Ctx,
    private taskId: number,
    private runId: number,
    private capBytes = LOG_CAP_BYTES,
  ) {}

  private redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out;
  }

  push(line: OutputLine): void {
    const text = this.redact(line.text);
    const tail = `${this.tails[line.stream]}${text}\n`;
    this.tails[line.stream] = tail.length > TAIL_CAP ? tail.slice(-TAIL_CAP) : tail;
    if (this.truncated) return;
    const size = Buffer.byteLength(text);
    if (this.stored + size > this.capBytes) {
      this.truncated = true;
      this.pending.push({ type: 'log_truncated' });
    } else {
      this.stored += size;
      this.pending.push({
        type: 'agent_output',
        payload: { runId: this.runId, stream: line.stream, text },
      });
    }
    if (this.pending.length >= FLUSH_LINES) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  stdoutTail(): string {
    return this.tails.stdout;
  }

  stderrTail(): string {
    return this.tails.stderr;
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0);
    if (batch.length === 0) return;
    try {
      write(this.ctx, (tx, outbox) => {
        const at = this.ctx.clock().toISOString();
        for (const p of batch) {
          insertEvent(tx, {
            taskId: this.taskId,
            type: p.type,
            ...(p.type === 'agent_output'
              ? { payload: p.payload }
              : { payload: { runId: this.runId } }),
            createdAt: at,
            processedAt: at,
          });
        }
        outbox.changed();
      });
    } catch (err) {
      this.ctx.logger.error('storing agent output failed', err);
    }
  }

  /** Writes what is left. Call before the run is finished. */
  close(): void {
    this.flush();
  }
}
