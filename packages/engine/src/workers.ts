import type { RunHandle } from '@jiraffe/adapters';
import {
  countOpenRuns,
  finishRun,
  insertRun,
  listRuns,
  listDueResumes,
  listUnprocessedEvents,
  markEventsProcessed,
  nextClaimCandidate,
} from '@jiraffe/db';
import { runAnalysis } from './analysis.ts';
import { selectRunner } from './agentRun.ts';
import { write, type Ctx } from './context.ts';
import { runExecution } from './execution.ts';
import { getSetting } from './settings.ts';
import { applyTransition, transition } from './transition.ts';
import type { AnalysisRole } from './prompts.ts';

export type RunKind = 'analysis' | 'execution';
export type AbortReason = 'cancelled' | 'deleted' | 'shutdown';

/** A run whose slot is held. `maxCredits` is what `--max-ai-credits` gets. */
export interface Claim {
  runId: number;
  taskId: number;
  kind: RunKind;
  role?: AnalysisRole;
  maxCredits: number;
}

export interface LiveRun {
  taskId: number;
  reason?: AbortReason;
  handle?: RunHandle;
  abort(reason: AbortReason): void;
}

export interface QueueState {
  started: boolean;
  autoAnalysis: boolean;
  active: Record<RunKind, number>;
  max: Record<RunKind, number>;
}

export interface Workers {
  /** In-memory: "Start queue" was pressed in this session. */
  queueStarted: boolean;
  /** Set when the boot sequence is done; nothing is claimed before. */
  ready: boolean;
  closed: boolean;
  live: Map<number, LiveRun>;
  pump(): void;
  /** The poller pass: dispatch, then mark events processed. */
  tick(): void;
  abort(taskId: number, reason: AbortReason): void;
  /** Resolves when no run is live. */
  idle(): Promise<void>;
  close(): void;
  queueState(): QueueState;
}

const MAX_KEY = {
  analysis: 'max_parallel_analysis',
  execution: 'max_parallel_execution',
} as const;
const KINDS: RunKind[] = ['analysis', 'execution'];

/**
 * One transaction: check the slot limit, pick the next task, start it (through transition()
 * for analysis, D4) and insert its run. Slots are counted as open runs, so a task resumed
 * into `analysing` or `running` waits for a slot like any other.
 */
export function claimNext(ctx: Ctx, kind: RunKind): Claim | null {
  // A plain read first: the poller calls this every 1.5 s and must not open a write transaction for nothing.
  if (!nextClaimCandidate(ctx.db, kind)) return null;
  return write(ctx, (tx, outbox) => {
    if (countOpenRuns(tx, kind) >= getSetting(ctx, MAX_KEY[kind])) return null;
    const c = nextClaimCandidate(tx, kind);
    if (!c) return null;
    if (c.status === 'queued_analysis')
      applyTransition(ctx, tx, outbox, c.taskId, 'analysis_started');
    const role = kind === 'analysis' ? ('analyst' as const) : undefined;
    const maxCredits = c.maxCredits ?? getSetting(ctx, 'default_max_credits');
    const runId = insertRun(tx, {
      taskId: c.taskId,
      kind,
      agent: selectRunner(ctx)?.id ?? 'copilot',
      maxCredits,
      startedAt: ctx.clock().toISOString(),
      ...(role ? { resultJson: JSON.stringify({ role }) } : {}),
    });
    outbox.changed();
    return { runId, taskId: c.taskId, kind, ...(role ? { role } : {}), maxCredits };
  });
}

/** Closes runs left open by a failure in the engine itself, so no slot leaks. */
function crashOpenRuns(ctx: Ctx, taskId: number): void {
  write(ctx, (tx, outbox) => {
    const now = ctx.clock().toISOString();
    for (const r of listRuns(tx, taskId).filter((x) => x.finishedAt === null))
      finishRun(tx, r.id, { endReason: 'crashed', finishedAt: now });
    outbox.changed();
  });
}

export function createWorkers(ctx: Ctx): Workers {
  const tracked = new Set<Promise<void>>();
  let pumping = false;
  let dirty = false;

  const launch = (claim: Claim) => {
    const p: Promise<void> = (
      claim.kind === 'analysis' ? runAnalysis(ctx, claim) : runExecution(ctx, claim)
    )
      .catch((err) => {
        ctx.logger.error('run failed unexpectedly', err);
        if (!w.closed) {
          try {
            crashOpenRuns(ctx, claim.taskId);
          } catch (e) {
            ctx.logger.error('closing a failed run failed', e);
          }
        }
      })
      .finally(() => {
        tracked.delete(p);
        if (!w.closed) w.pump();
      });
    tracked.add(p);
  };

  const w: Workers = {
    queueStarted: false,
    ready: false,
    closed: false,
    live: new Map(),

    pump() {
      if (!w.ready || w.closed) return;
      if (pumping) {
        dirty = true;
        return;
      }
      pumping = true;
      try {
        do {
          dirty = false;
          for (const kind of KINDS) {
            if (!nextClaimCandidate(ctx.db, kind)) continue;
            if (kind === 'analysis' && !(w.queueStarted || getSetting(ctx, 'auto_analysis')))
              continue;
            for (let claim = claimNext(ctx, kind); claim; claim = claimNext(ctx, kind))
              launch(claim);
          }
        } while (dirty);
      } catch (err) {
        ctx.logger.error('dispatching runs failed', err);
      } finally {
        pumping = false;
      }
    },

    tick() {
      if (w.closed) return;
      // Paused tasks whose resume time has passed go back to where they were; the claim then
      // starts a fresh run for them within the slot limits.
      for (const id of listDueResumes(ctx.db, ctx.clock().toISOString())) {
        try {
          transition(ctx, id, 'resume');
        } catch (err) {
          ctx.logger.error('resuming a paused task failed', err);
        }
      }
      const open = listUnprocessedEvents(ctx.db, 500);
      if (open.length === 0) return; // events are wake-up hints; settings changes pump on their own
      w.pump();
      write(ctx, (tx) =>
        markEventsProcessed(
          tx,
          open.map((e) => e.id),
          ctx.clock().toISOString(),
        ),
      );
    },

    abort(taskId, reason) {
      for (const live of w.live.values()) if (live.taskId === taskId) live.abort(reason);
    },

    async idle() {
      while (tracked.size > 0) await Promise.allSettled([...tracked]);
    },

    close() {
      w.closed = true;
      for (const live of w.live.values()) live.abort('shutdown');
    },

    queueState() {
      const active = {
        analysis: countOpenRuns(ctx.db, 'analysis'),
        execution: countOpenRuns(ctx.db, 'execution'),
      };
      return {
        started: w.queueStarted,
        autoAnalysis: getSetting(ctx, 'auto_analysis'),
        active,
        max: {
          analysis: getSetting(ctx, MAX_KEY.analysis),
          execution: getSetting(ctx, MAX_KEY.execution),
        },
      };
    },
  };
  return w;
}
