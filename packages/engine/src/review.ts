import {
  deleteBranch,
  diffSince,
  removeWorktree,
  resolveInside,
  worktreesRoot,
} from '@jiraffe/adapters';
import {
  ConflictError,
  TaskNotFoundError,
  type DiffDto,
  type LogsDto,
  type TaskExtrasDto,
} from '@jiraffe/core';
import { getTaskDto, latestEventOfType, listEventsAfter, listWorktreeRuns } from '@jiraffe/db';
import type { Ctx } from './context.ts';
import { canDelegate } from './delegate.ts';
import { getSetting } from './settings.ts';

const MAX_PAGE = 500;

/** The task's latest worktree, re-validated against the configured worktrees directory. */
function worktreeOf(ctx: Ctx, taskId: number) {
  const task = getTaskDto(ctx.db, taskId);
  if (!task) throw new TaskNotFoundError();
  const run = listWorktreeRuns(ctx.db, taskId)[0];
  if (!run?.worktreePath || !run.branch || !run.baseCommit)
    throw new ConflictError('This task has no worktree');
  if (!task.repoPath) throw new ConflictError('This task has no repository');
  const root = worktreesRoot(task.repoPath, getSetting(ctx, 'worktrees_dir'));
  const path = resolveInside(root, run.worktreePath);
  if (!path || path === root)
    throw new ConflictError('The worktree is outside the configured worktrees directory');
  return { task, repo: task.repoPath, path, branch: run.branch, base: run.baseCommit };
}

export async function getDiff(ctx: Ctx, taskId: number): Promise<DiffDto> {
  const w = worktreeOf(ctx, taskId);
  if (w.task.deletedAt) throw new TaskNotFoundError();
  const d = await diffSince(ctx.git, w.path, w.base);
  if (!d.ok) throw new ConflictError(d.error);
  return { diff: d.diff, truncated: d.truncated, base: w.base };
}

/** Output lines after an event id, oldest first. */
export function getLogs(ctx: Ctx, taskId: number, after: number, limit: number): LogsDto {
  const task = getTaskDto(ctx.db, taskId);
  if (!task || task.deletedAt) throw new TaskNotFoundError();
  const rows = listEventsAfter(
    ctx.db,
    taskId,
    ['agent_output', 'log_truncated'],
    after,
    Math.min(Math.max(limit, 1), MAX_PAGE),
  );
  return {
    truncated: rows.some((r) => r.type === 'log_truncated'),
    lines: rows
      .filter((r) => r.type === 'agent_output')
      .map((r) => {
        const p = JSON.parse(r.payloadJson ?? '{}') as {
          runId: number;
          stream: 'stdout' | 'stderr';
          text: string;
        };
        return { id: r.id, runId: p.runId, stream: p.stream, text: p.text, at: r.createdAt };
      }),
  };
}

/**
 * After a soft delete with "also remove the worktree and branch": removes this task's own
 * worktree and branch only. Returns an error text instead of throwing; the task stays deleted.
 */
export async function removeWorktreeAndBranch(ctx: Ctx, taskId: number): Promise<string | null> {
  const task = getTaskDto(ctx.db, taskId);
  if (!task?.deletedAt) throw new ConflictError('Delete the task first');
  let w: ReturnType<typeof worktreeOf>;
  try {
    w = worktreeOf(ctx, taskId);
  } catch {
    return null; // nothing to remove
  }
  if (w.branch !== `task/${task.key}`) return 'The recorded branch does not belong to this task';
  const rm = await removeWorktree(ctx.git, w.repo, w.path);
  if (!rm.ok) return rm.error;
  const br = await deleteBranch(ctx.git, w.repo, w.branch);
  return br.ok ? null : br.error;
}

export function taskExtras(ctx: Ctx, taskId: number): TaskExtrasDto {
  const task = getTaskDto(ctx.db, taskId);
  if (!task) throw new TaskNotFoundError();
  const hasWorktree = listWorktreeRuns(ctx.db, taskId).length > 0;
  let lastError: TaskExtrasDto['lastError'] = null;
  if (task.status === 'failed') {
    const e = latestEventOfType(ctx.db, taskId, 'run_error');
    if (e) {
      const p = JSON.parse(e.payloadJson ?? '{}') as { message?: string; tail?: string };
      lastError = { message: p.message ?? 'The run failed', tail: p.tail ?? null };
    }
  }
  return {
    delegate: canDelegate(ctx, taskId),
    lastError,
    restartsInWorktree: hasWorktree && (task.status === 'delegated' || task.status === 'running'),
    hasWorktree,
  };
}
