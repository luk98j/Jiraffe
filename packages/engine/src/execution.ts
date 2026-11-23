import {
  ensureWorktree,
  addInfoExclude,
  headCommit,
  resolveWorktreePath,
  writeInside,
} from '@jiraffe/adapters';
import { finishRun, getTaskDto, listMessages, listWorktreeRuns, setRunWorktree } from '@jiraffe/db';
import { failRun, runAgent, selectRunner } from './agentRun.ts';
import { classify, failureText } from './classify.ts';
import { buildContext } from './contextFile.ts';
import { write, type Ctx } from './context.ts';
import { analysisVerdicts } from './delegate.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';
import type { Claim } from './workers.ts';

export const CONTEXT_FILE = '.orchestrator/context.md';

const isActive = (s: string) => s === 'delegated' || s === 'running';

/**
 * Execution for a claimed `delegated` task (or a resumed `running` one):
 * worktree, context file, then the agent inside the worktree, then review.
 * Every failure before the agent starts ends the run and the task in ONE transaction
 * that first applies `execution_started`, so the task is never visible as running (X1).
 */
export async function runExecution(ctx: Ctx, claim: Claim): Promise<void> {
  const cancel = () =>
    write(ctx, (tx, outbox) => {
      finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: ctx.clock().toISOString() });
      outbox.changed();
    });
  const task = getTaskDto(ctx.db, claim.taskId);
  if (!task || task.deletedAt || !isActive(task.status)) return cancel();

  const failEarly = (message: string) =>
    write(ctx, (tx, outbox) => {
      const t = getTaskDto(tx, claim.taskId);
      if (!t || t.deletedAt || !isActive(t.status)) {
        finishRun(tx, claim.runId, {
          endReason: 'cancelled',
          finishedAt: ctx.clock().toISOString(),
        });
        return outbox.changed();
      }
      if (t.status === 'delegated') applyTransition(ctx, tx, outbox, t.id, 'execution_started');
      failRun(ctx, tx, outbox, claim, message);
    });

  const allowedTools = getSetting(ctx, 'allowed_tools');
  const runner = selectRunner(ctx);
  if (!runner) return failEarly('No agent adapter is configured');
  const pre = runner.preflight('execution', { allowedTools });
  if (!pre.ok) return failEarly(pre.reason);
  const repo = task.repoPath?.trim();
  if (!repo) return failEarly('Repository is not set');

  const wt = resolveWorktreePath(repo, getSetting(ctx, 'worktrees_dir'), task.key);
  if (!wt.ok) return failEarly(wt.reason);
  const branch = `task/${task.key}`;

  // A retry diffs against the first base, so the review covers all work on the branch.
  let base = listWorktreeRuns(ctx.db, task.id).at(-1)?.baseCommit ?? null;
  if (!base) {
    const head = await headCommit(ctx.git, repo);
    if (!head.ok) return failEarly(head.error);
    base = head.commit;
  }
  const made = await ensureWorktree(ctx.git, repo, wt.path, branch);
  if (!made.ok) return failEarly(made.error);

  const context = buildContext({
    key: task.key,
    status: task.status,
    analysis: analysisVerdicts(ctx, task.id),
    comments: listMessages(ctx.db, task.id).filter((m) => m.role === 'user' || m.source === 'jira'),
  });
  const written = writeInside(wt.path, CONTEXT_FILE, context);
  if (!written.ok) return failEarly(written.error);
  const excluded = await addInfoExclude(ctx.git, wt.path);
  if (!excluded.ok) return failEarly(excluded.error);
  if (ctx.workers.closed) return;

  // The worktree exists: record it on the run, then start the task.
  const started = write(ctx, (tx, outbox) => {
    const t = getTaskDto(tx, claim.taskId);
    if (!t || t.deletedAt || !isActive(t.status)) {
      finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: ctx.clock().toISOString() });
      outbox.changed();
      return false;
    }
    setRunWorktree(tx, claim.runId, {
      worktreePath: wt.path,
      branch,
      baseCommit: base as string,
    });
    if (t.status === 'delegated') applyTransition(ctx, tx, outbox, t.id, 'execution_started');
    return true;
  });
  if (!started) return;

  const values: Record<string, string> = {
    task_key: task.key,
    title: task.title,
    body: task.body,
    context,
  };
  // One pass with a function replacer: task text is never re-scanned for placeholders.
  const prompt = getSetting(ctx, 'execution_prompt_template').replace(
    /\{\{(\w+)\}\}/g,
    (_m, k: string) => values[k] ?? '',
  );
  const res = await runAgent(ctx, claim, { prompt, cwd: wt.path, allowedTools });
  if (ctx.workers.closed) return;

  write(ctx, (tx, outbox) => {
    const now = ctx.clock().toISOString();
    const t = getTaskDto(tx, claim.taskId);
    const reason = classify(res.outcome, !!res.aborted);
    if (reason === 'cancelled' || !t || t.deletedAt || t.status !== 'running') {
      finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: now });
      outbox.changed();
    } else if (reason === 'crashed') {
      const text = failureText(res.outcome, getSetting(ctx, 'run_timeout_minutes'));
      failRun(ctx, tx, outbox, claim, text, res);
    } else {
      finishRun(tx, claim.runId, { endReason: 'completed', finishedAt: now });
      applyTransition(ctx, tx, outbox, claim.taskId, 'execution_done');
    }
  });
}
