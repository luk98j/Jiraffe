import type { Db, Tx } from './client.ts';
import { events } from './schema.ts';

export function insertEvent(
  tx: Db | Tx,
  e: { taskId: number; type: string; payload?: unknown; createdAt: string },
): void {
  tx.insert(events)
    .values({
      taskId: e.taskId,
      type: e.type,
      payloadJson: e.payload === undefined ? null : JSON.stringify(e.payload),
      createdAt: e.createdAt,
    })
    .run();
}
