import { validateAllowedTools } from './allowlist.ts';
import { runCommand } from './exec.ts';
import type { ProfileEntry } from './profile.ts';
import { failedStart, type AgentRunner, type RunHandle, type RunOptions } from './runner.ts';
import type { Spawner } from './spawner.ts';

export interface CopilotProfile {
  prompt: ProfileEntry;
  maxCredits: ProfileEntry;
  agent: ProfileEntry;
  model: ProfileEntry;
  /** Spec section 12 item 1: no flag text is known, so none is written here. */
  allowTool: ProfileEntry<(tools: readonly string[]) => string[]>;
  resume: ProfileEntry;
  creditLimitSignal: ProfileEntry;
  quotaResetTime: ProfileEntry;
}

const docs = 'confirmed in the documentation (spec section 8)';

/** The four flags below are the only ones this adapter emits. Everything else stays UNVERIFIED. */
export const copilotProfile: CopilotProfile = {
  prompt: { status: 'confirmed', note: `-p <prompt>, ${docs}` },
  maxCredits: { status: 'confirmed', note: `--max-ai-credits <n>, ${docs}` },
  agent: { status: 'confirmed', note: `--agent=<name>, ${docs}` },
  model: { status: 'confirmed', note: `--model=<name>, ${docs}` },
  allowTool: {
    status: 'unverified',
    spec12Item: 1,
    note: 'Tool allowlist flag in -p mode is not confirmed; execution fails closed',
  },
  resume: { status: 'unverified', spec12Item: 2, note: 'Resume by session id is not confirmed' },
  creditLimitSignal: {
    status: 'unverified',
    spec12Item: 3,
    note: 'Exit code and message at the credit limit are not confirmed',
  },
  quotaResetTime: {
    status: 'unverified',
    spec12Item: 3,
    note: 'Format of the usage-limit reset time is not confirmed',
  },
};

const SAFE_VALUE = /^[A-Za-z0-9][\w.:/@-]*$/;

export type BuiltArgs = { args: string[] } | { error: string };

/**
 * Builds the argument list from confirmed profile entries only. It has no code path that
 * emits an unrestricted-mode flag, whatever the options say.
 */
export function buildCopilotArgs(
  prompt: string,
  o: Pick<RunOptions, 'model' | 'agentName' | 'maxCredits' | 'allowedTools'>,
  profile: CopilotProfile = copilotProfile,
): BuiltArgs {
  if (!Number.isFinite(o.maxCredits) || o.maxCredits <= 0)
    return { error: 'maxCredits must be a positive number' };
  for (const [label, v] of [
    ['model', o.model],
    ['agent', o.agentName],
  ] as const) {
    if (v !== undefined && !SAFE_VALUE.test(v)) return { error: `Invalid ${label} name` };
  }
  const args = ['-p', prompt, '--max-ai-credits', String(o.maxCredits)];
  if (o.model !== undefined) args.push(`--model=${o.model}`);
  if (o.agentName !== undefined) args.push(`--agent=${o.agentName}`);
  if (o.allowedTools !== undefined) {
    const check = validateAllowedTools(o.allowedTools);
    if (!check.ok) return { error: check.reason };
    const build = profile.allowTool.status === 'confirmed' ? profile.allowTool.args : undefined;
    if (!build) return { error: 'Tool restriction flag is not confirmed (spec section 12 item 1)' };
    args.push(...build(o.allowedTools));
  }
  return { args };
}

export function createCopilotRunner(
  spawner: Spawner,
  profile: CopilotProfile = copilotProfile,
): AgentRunner {
  return {
    id: 'copilot',
    preflight(kind, o) {
      if (kind === 'execution' && o.allowedTools === undefined)
        return { ok: false, reason: 'Execution needs an allowlist' };
      const built = buildCopilotArgs(
        '',
        { maxCredits: 1, ...(o.allowedTools ? { allowedTools: o.allowedTools } : {}) },
        profile,
      );
      return 'error' in built ? { ok: false, reason: built.error } : { ok: true };
    },
    start(prompt, cwd, o): RunHandle {
      const built = buildCopilotArgs(prompt, o, profile);
      if ('error' in built) return failedStart(built.error);
      return runCommand(spawner, 'copilot', built.args, {
        cwd,
        timeoutMs: o.timeoutMs,
        onOutput: o.onOutput,
      });
    },
  };
}
