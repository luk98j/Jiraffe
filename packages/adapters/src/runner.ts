export type AgentId = 'copilot' | 'claude';

export interface OutputLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface RunOptions {
  model?: string;
  agentName?: string;
  maxCredits: number;
  /** Execution only: the exact value of the `allowed_tools` setting. */
  allowedTools?: readonly string[];
  timeoutMs: number;
  /** Called for every output line, in order. Registered before the process is spawned. */
  onOutput: (line: OutputLine) => void;
}

export interface RunOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The run could not start (binary missing, adapter not verified, allowlist refused). */
  spawnError?: string;
  /** The fields below are set only when a CONFIRMED profile entry can detect them. */
  creditLimitReached?: boolean;
  creditsUsed?: number;
  sessionId?: string;
  quotaResetAt?: string;
}

export interface RunHandle {
  pid: number | undefined;
  /** Kills the process group and resolves when the run has settled. */
  cancel(): Promise<void>;
  result: Promise<RunOutcome>;
}

export type Preflight = { ok: true } | { ok: false; reason: string };

export interface AgentRunner {
  id: AgentId;
  /** Can a run of this kind start at all with these options? Used to fail closed. */
  preflight(kind: 'analysis' | 'execution', o: { allowedTools?: readonly string[] }): Preflight;
  /** Never throws: every failure resolves through `result`. */
  start(prompt: string, cwd: string, o: RunOptions): RunHandle;
  /** Optional; nothing depends on it (spec section 12 item 2 is open). */
  resume?(sessionId: string, o: RunOptions): RunHandle;
}

/** Outcome of a run that never started. */
export const failedStart = (spawnError: string): RunHandle => ({
  pid: undefined,
  cancel: async () => {},
  result: Promise.resolve({
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError,
  }),
});
