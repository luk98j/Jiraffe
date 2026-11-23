import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Statement } from 'better-sqlite3';
import type { Db, Tx } from './client.ts';
import { events } from './schema.ts';

export function insertEvent(
  tx: Db | Tx,
  e: { taskId: number; type: string; payload?: unknown; createdAt: string; processedAt?: string },
): void {
  tx.insert(events)
    .values({
      taskId: e.taskId,
      type: e.type,
      payloadJson: e.payload === undefined ? null : JSON.stringify(e.payload),
      processedAt: e.processedAt ?? null,
      createdAt: e.createdAt,
    })
    .run();
}

// The poller reads this every 1.5 s, so the statement is prepared once per connection.
const unprocessed = new WeakMap<
  object,
  Statement<[number], { id: number; taskId: number; type: string }>
>();

export function listUnprocessedEvents(db: Db, limit: number) {
  const client = db.$client;
  let stmt = unprocessed.get(client);
  if (!stmt) {
    stmt = client.prepare(
      'SELECT id, task_id AS taskId, type FROM events WHERE processed_at IS NULL ORDER BY id LIMIT ?',
    );
    unprocessed.set(client, stmt);
  }
  return stmt.all(limit);
}

export function markEventsProcessed(tx: Db | Tx, ids: number[], now: string): void {
  if (ids.length === 0) return;
  tx.update(events).set({ processedAt: now }).where(inArray(events.id, ids)).run();
}

/** Events of a task after `afterId` (exclusive), oldest first, for paging logs. */
export function listEventsAfter(
  db: Db | Tx,
  taskId: number,
  types: string[],
  afterId: number,
  limit: number,
) {
  return db
    .select({
      id: events.id,
      type: events.type,
      payloadJson: events.payloadJson,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.taskId, taskId), inArray(events.type, types), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(limit)
    .all();
}

export function latestEventOfType(db: Db | Tx, taskId: number, type: string) {
  return db
    .select({ id: events.id, payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, type)))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
}
