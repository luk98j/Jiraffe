import { validateAllowedTools } from '@jiraffe/adapters';
import { ConflictError, TaskNotFoundError, type DelegateDto } from '@jiraffe/core';
import { getTaskDto, listRuns } from '@jiraffe/db';
import { selectRunner } from './agentRun.ts';
import { parseResult } from './analysis.ts';
import { permissionsOf } from './contextFile.ts';
import { write, type Ctx } from './context.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';

export function analysisVerdicts(ctx: Ctx, taskId: number) {
  return listRuns(ctx.db, taskId, 'analysis')
    .filter((r) => r.endReason === 'completed')
    .flatMap((r) => {
      const res = parseResult(r.resultJson);
      return res.verdict ? [{ role: res.role ?? 'analyst', verdict: res.verdict }] : [];
    });
}

/**
 * Can this task be delegated now? The first failing check wins and gives a readable reason.
 * A busy execution slot is not a failure: the task simply waits as `delegated`.
 */
export function canDelegate(ctx: Ctx, taskId: number): DelegateDto {
  const task = getTaskDto(ctx.db, taskId);
  if (!task || task.deletedAt) throw new TaskNotFoundError();
  const permissions = permissionsOf(analysisVerdicts(ctx, taskId));
  const no = (reason: string): DelegateDto => ({ ok: false, reason, permissions });

  if (task.status !== 'ready_to_delegate')
    return no(`The task is ${task.status}, not ready to delegate`);
  if (task.hasNewComment)
    return no('A new message arrived after the analysis, re-run the analysis');
  if (task.bodyChangedAfterAnalysis) return no('Description changed in Jira, re-run the analysis');
  if (!task.repoPath?.trim()) return no('Choose a repository first');
  const allowedTools = getSetting(ctx, 'allowed_tools');
  const list = validateAllowedTools(allowedTools);
  if (!list.ok) return no(list.reason);
  const runner = selectRunner(ctx);
  if (!runner) return no('No agent adapter is configured');
  const pre = runner.preflight('execution', { allowedTools });
  if (!pre.ok) return no(pre.reason);
  return { ok: true, reason: null, permissions };
}

/** Re-checks and moves the task to `delegated` in one transaction. */
export function delegate(ctx: Ctx, taskId: number): void {
  write(ctx, (tx, outbox) => {
    const c = canDelegate(ctx, taskId);
    if (!c.ok) throw new ConflictError(c.reason ?? 'The task cannot be delegated');
    applyTransition(ctx, tx, outbox, taskId, 'delegate');
  });
}
