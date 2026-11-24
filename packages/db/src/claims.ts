import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import type { RunKind } from './runs.ts';

export interface ClaimCandidate {
  taskId: number;
  status: string;
  maxCredits: number | null;
}

/**
 * The next task a worker may take, ordered by priority then updated_at (spec section 5).
 * Besides the queued/delegated start state, a task already in `analysing` or `running`
 * with no open run is a candidate: it was resumed or recovered and needs a fresh run.
 * Deleted tasks and tasks with an unfinished run are never returned.
 */
export function nextClaimCandidate(db: Db | Tx, kind: RunKind): ClaimCandidate | undefined {
  const [start, active] =
    kind === 'analysis' ? ['queued_analysis', 'analysing'] : ['delegated', 'running'];
  const row = db.get<{ id: number; status: string; maxCredits: number | null }>(sql`
    SELECT t.id AS id, t.status AS status, t.max_credits AS maxCredits FROM tasks t
    WHERE t.deleted_at IS NULL
      AND t.status IN (${start}, ${active})
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.finished_at IS NULL)
    ORDER BY t.priority, t.updated_at, t.id
    LIMIT 1`);
  return row && { taskId: row.id, status: row.status, maxCredits: row.maxCredits };
}
