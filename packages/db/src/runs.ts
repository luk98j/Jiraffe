import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { runs } from './schema.ts';

export type RunKind = 'analysis' | 'execution';
export type RunEndReason = 'completed' | 'credit_limit' | 'quota' | 'crashed' | 'cancelled';
export type RunRow = typeof runs.$inferSelect;

export function insertRun(
  tx: Db | Tx,
  r: {
    taskId: number;
    kind: RunKind;
    agent: string;
    maxCredits: number;
    startedAt: string;
    resultJson?: string;
  },
): number {
  return tx
    .insert(runs)
    .values({ ...r, status: 'running' })
    .returning({ id: runs.id })
    .get().id;
}

export function setRunPid(tx: Db | Tx, id: number, pid: number | null): void {
  tx.update(runs).set({ pid }).where(eq(runs.id, id)).run();
}

/** Closes a run. The patch is built in a variable on purpose: see the status-writer architecture rule. */
export function finishRun(
  tx: Db | Tx,
  id: number,
  f: {
    endReason: RunEndReason;
    finishedAt: string;
    resultJson?: string;
    creditsUsed?: number;
    sessionId?: string;
  },
): void {
  const patch = {
    status: 'finished' as const,
    pid: null,
    endReason: f.endReason,
    finishedAt: f.finishedAt,
    ...(f.resultJson !== undefined ? { resultJson: f.resultJson } : {}),
    ...(f.creditsUsed !== undefined ? { creditsUsed: f.creditsUsed } : {}),
    ...(f.sessionId !== undefined ? { sessionId: f.sessionId } : {}),
  };
  tx.update(runs).set(patch).where(eq(runs.id, id)).run();
}

/** Stores the verdict of an open run without closing it. */
export function setRunResult(tx: Db | Tx, id: number, resultJson: string): void {
  tx.update(runs).set({ resultJson }).where(eq(runs.id, id)).run();
}

export function getRun(db: Db | Tx, id: number): RunRow | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

/** Runs without a finish time. They are the slots in use. */
export function countOpenRuns(db: Db | Tx, kind: RunKind): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.kind, kind), isNull(runs.finishedAt)))
      .get()?.n ?? 0
  );
}

/** Oldest first. */
export function listRuns(db: Db | Tx, taskId: number, kind?: RunKind): RunRow[] {
  return db
    .select()
    .from(runs)
    .where(kind ? and(eq(runs.taskId, taskId), eq(runs.kind, kind)) : eq(runs.taskId, taskId))
    .orderBy(asc(runs.id))
    .all();
}
