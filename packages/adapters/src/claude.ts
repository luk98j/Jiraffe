import { validateAllowedTools } from './allowlist.ts';
import { runCommand } from './exec.ts';
import type { ProfileEntry } from './profile.ts';
import { failedStart, type AgentRunner, type RunHandle, type RunOptions } from './runner.ts';
import type { Spawner } from './spawner.ts';

export interface ClaudeProfile {
  prompt: ProfileEntry<(prompt: string) => string[]>;
  maxBudget: ProfileEntry<(credits: number) => string[]>;
  model: ProfileEntry<(model: string) => string[]>;
  allowTool: ProfileEntry<(tools: readonly string[]) => string[]>;
  resume: ProfileEntry;
}

const unknown = (what: string): { status: 'unverified'; note: string } => ({
  status: 'unverified',
  note: `${what} is not confirmed: this run has no Claude Code binary or documentation to check against`,
});

/**
 * Every entry is UNVERIFIED and carries no flag text, so the adapter cannot build a command
 * and fails closed. An entry is turned on only after the owner confirms it on a machine with
 * `claude` (a follow-up change), never by guessing.
 */
export const claudeProfile: ClaudeProfile = {
  prompt: unknown('Non-interactive prompt invocation'),
  maxBudget: unknown('A per-run budget limit'),
  model: unknown('Model selection'),
  allowTool: unknown('A tool allowlist'),
  resume: unknown('Session resume'),
};

export const CLAUDE_NOT_VERIFIED = 'Claude Code adapter is not verified';

export type BuiltClaudeArgs = { args: string[] } | { error: string };

/**
 * Builds the argument list from confirmed profile entries only. The prompt and a budget
 * limit are required: without both the adapter refuses rather than run unlimited.
 * It has no code path that emits an unrestricted-mode, skip-permissions or allow-all flag.
 */
export function buildClaudeArgs(
  prompt: string,
  o: Pick<RunOptions, 'model' | 'maxCredits' | 'allowedTools'>,
  profile: ClaudeProfile = claudeProfile,
): BuiltClaudeArgs {
  const p = profile.prompt.status === 'confirmed' ? profile.prompt.args : undefined;
  const b = profile.maxBudget.status === 'confirmed' ? profile.maxBudget.args : undefined;
  if (!p || !b) return { error: CLAUDE_NOT_VERIFIED };
  if (!Number.isFinite(o.maxCredits) || o.maxCredits <= 0)
    return { error: 'maxCredits must be a positive number' };
  const args = [...p(prompt), ...b(o.maxCredits)];
  if (o.model !== undefined) {
    const m = profile.model.status === 'confirmed' ? profile.model.args : undefined;
    if (!m || !/^[A-Za-z0-9][\w.:/@-]*$/.test(o.model))
      return { error: 'Model selection is not verified' };
    args.push(...m(o.model));
  }
  if (o.allowedTools !== undefined) {
    const check = validateAllowedTools(o.allowedTools);
    if (!check.ok) return { error: check.reason };
    const t = profile.allowTool.status === 'confirmed' ? profile.allowTool.args : undefined;
    if (!t) return { error: 'The tool allowlist flag is not confirmed' };
    args.push(...t(o.allowedTools));
  }
  return { args };
}

export function createClaudeRunner(
  spawner: Spawner,
  profile: ClaudeProfile = claudeProfile,
): AgentRunner {
  return {
    id: 'claude',
    preflight(kind, o) {
      if (kind === 'execution' && o.allowedTools === undefined)
        return { ok: false, reason: 'Execution needs an allowlist' };
      const built = buildClaudeArgs(
        '',
        { maxCredits: 1, ...(o.allowedTools ? { allowedTools: o.allowedTools } : {}) },
        profile,
      );
      return 'error' in built ? { ok: false, reason: built.error } : { ok: true };
    },
    start(prompt, cwd, o): RunHandle {
      const built = buildClaudeArgs(prompt, o, profile);
      if ('error' in built) return failedStart(built.error);
      return runCommand(spawner, 'claude', built.args, {
        cwd,
        timeoutMs: o.timeoutMs,
        onOutput: o.onOutput,
      });
    },
  };
}
