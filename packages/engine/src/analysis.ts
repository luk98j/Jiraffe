import { parseVerdict, type Verdict } from '@jiraffe/core';
import {
  finishRun,
  getRun,
  getTaskDto,
  insertMessage,
  insertRun,
  listMessages,
  listRuns,
  type Tx,
} from '@jiraffe/db';
import { failRun as fail, runAgent, selectRunner, type AgentResult } from './agentRun.ts';
import { failureText } from './classify.ts';
import { classifyResult, pauseForLimit } from './quota.ts';
import { write, type Ctx, type Outbox } from './context.ts';
import { buildAnalysisPrompt, type AnalysisRole } from './prompts.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';
import type { Claim } from './workers.ts';

const ANSWER_CAP = 64 * 1024;

interface StoredResult {
  role?: AnalysisRole;
  verdict?: Verdict;
  answer?: string;
}

export const parseResult = (json: string | null): StoredResult => {
  try {
    return json ? (JSON.parse(json) as StoredResult) : {};
  } catch {
    return {};
  }
};

const NOT_STARTED = { exitCode: null, signal: null, timedOut: false, cancelled: false };

const isClean = (v: Verdict) =>
  v.verdict === 'READY' && v.questions.length === 0 && v.missing.length === 0;

/** Runs the business analyst, then the architect, on one slot. Each is its own `runs` row. */
export async function runAnalysis(ctx: Ctx, first: Claim): Promise<void> {
  let claim: Claim | null = first;
  while (claim) claim = await analysisStep(ctx, claim);
}

/** `git status` of the repository, or null when it cannot be read (not a git repository). */
async function repoState(ctx: Ctx, cwd: string): Promise<string | null> {
  const r = await ctx.git.run(['status', '--porcelain'], { cwd }).catch(() => null);
  return r && r.code === 0 ? r.stdout : null;
}

async function analysisStep(ctx: Ctx, claim: Claim): Promise<Claim | null> {
  const role = claim.role ?? 'analyst';
  const task = getTaskDto(ctx.db, claim.taskId);
  if (!task || task.deletedAt || task.status !== 'analysing') return endCancelled(ctx, claim);

  // The prompt is built from the database now, so messages that arrived since the last run are in it.
  const analystAnswer =
    role === 'architect'
      ? listRuns(ctx.db, task.id, 'analysis')
          .filter((r) => r.id < claim.runId && r.endReason === 'completed')
          .map((r) => parseResult(r.resultJson))
          .findLast((r) => r.role === 'analyst')?.answer
      : undefined;
  const previous = analystAnswer ? [{ role: 'analyst' as const, answer: analystAnswer }] : [];
  const prompt = buildAnalysisPrompt({
    role,
    title: task.title,
    body: task.body,
    messages: listMessages(ctx.db, task.id),
    previous,
  });

  const cwd = task.repoPath?.trim() ?? '';
  let res: AgentResult;
  let changedRepo = false;
  if (!cwd) {
    res = {
      outcome: { ...NOT_STARTED, spawnError: 'Repository is not set' },
      aborted: undefined,
      stdout: '',
      stderr: '',
    };
  } else {
    // The analysis is read-only by instruction only; this check catches a repository the agent changed.
    const before = await repoState(ctx, cwd);
    res = await runAgent(ctx, claim, { prompt, cwd });
    if (ctx.workers.closed) return null;
    const after = before === null ? null : await repoState(ctx, cwd);
    changedRepo = before !== null && after !== null && before !== after;
  }
  if (ctx.workers.closed) return null;

  return write(ctx, (tx, outbox) => finish(ctx, tx, outbox, claim, role, res, changedRepo));
}

function endCancelled(ctx: Ctx, claim: Claim): null {
  write(ctx, (tx, outbox) => {
    finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: ctx.clock().toISOString() });
    outbox.changed();
  });
  return null;
}

/** The single finish transaction: result row first, then the status change. */
function finish(
  ctx: Ctx,
  tx: Tx,
  outbox: Outbox,
  claim: Claim,
  role: AnalysisRole,
  res: AgentResult,
  changedRepo: boolean,
): Claim | null {
  const now = ctx.clock().toISOString();
  const task = getTaskDto(tx, claim.taskId);
  const reason = classifyResult(ctx, res);
  if (reason === 'cancelled' || !task || task.deletedAt || task.status !== 'analysing') {
    finishRun(tx, claim.runId, { endReason: 'cancelled', finishedAt: now });
    outbox.changed();
    return null; // the result is discarded; whoever changed the task owns its status
  }
  if (reason === 'quota' || reason === 'credit_limit')
    return pauseForLimit(ctx, tx, outbox, claim, reason, res);
  if (reason === 'crashed') {
    const text = failureText(res.outcome, getSetting(ctx, 'run_timeout_minutes'));
    return fail(ctx, tx, outbox, claim, text, res);
  }
  if (changedRepo)
    return fail(ctx, tx, outbox, claim, 'The analysis changed files in the repository');
  const parsed = parseVerdict(res.stdout);
  if (!parsed.ok) return fail(ctx, tx, outbox, claim, 'Agent returned no valid verdict');

  const v = parsed.verdict;
  finishRun(tx, claim.runId, {
    endReason: 'completed',
    finishedAt: now,
    resultJson: JSON.stringify({ role, verdict: v, answer: res.stdout.slice(-ANSWER_CAP) }),
  });

  if (role === 'analyst' && isClean(v)) {
    const agent = getRun(tx, claim.runId)?.agent ?? selectRunner(ctx)?.id ?? 'copilot';
    const runId = insertRun(tx, {
      taskId: claim.taskId,
      kind: 'analysis',
      agent,
      maxCredits: claim.maxCredits,
      startedAt: now,
      resultJson: JSON.stringify({ role: 'architect' }),
    });
    outbox.changed();
    return { ...claim, runId, role: 'architect' };
  }

  // The architect only runs after a clean analyst result, so the analyst's verdict is clean here.
  const analyst =
    role === 'architect'
      ? listRuns(tx, claim.taskId, 'analysis')
          .filter((r) => r.id < claim.runId && r.endReason === 'completed')
          .map((r) => parseResult(r.resultJson))
          .findLast((r) => r.role === 'analyst')?.verdict
      : v;
  if (!analyst) return fail(ctx, tx, outbox, claim, 'The analyst result is missing');

  if (isClean(analyst) && isClean(v)) {
    applyTransition(ctx, tx, outbox, claim.taskId, 'analysis_ready');
    return null;
  }
  const notes = [...v.questions, ...v.missing.map((m) => `Missing: ${m}`)];
  for (const content of notes.length > 0 ? notes : [v.summary || 'More information is needed']) {
    insertMessage(tx, {
      taskId: claim.taskId,
      role: 'agent',
      source: 'app',
      content,
      createdAt: now,
    });
  }
  applyTransition(ctx, tx, outbox, claim.taskId, 'analysis_needs_info');
  return null;
}
