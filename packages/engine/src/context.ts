import type { Db, Tx } from '@jiraffe/db';
import type { JiraClient } from '@jiraffe/jira';
import type { SyncStateDto } from '@jiraffe/core';
import type { Bus, DomainEvent, Logger } from './bus.ts';

export interface Ctx {
  db: Db;
  bus: Bus;
  clock: () => Date;
  logger: Logger;
  version: string;
  jiraClient?: JiraClient;
  /** Mutable in-memory sync state shared by task and comment sync. */
  sync: { state: SyncStateDto; inFlight: boolean };
}

/** Collects notifications during a transaction; they are sent only after commit. */
export class Outbox {
  private events: DomainEvent[] = [];
  private dirty = false;

  emitEvent(e: DomainEvent): void {
    this.events.push(e);
  }

  changed(): void {
    this.dirty = true;
  }

  flush(bus: Bus): void {
    for (const e of this.events) bus.emitEvent(e);
    if (this.dirty) bus.emitChanged();
  }
}

/** The one write path: an immediate SQLite transaction, then the outbox. A throw rolls back and drops the outbox. */
export function write<T>(ctx: Ctx, fn: (tx: Tx, outbox: Outbox) => T): T {
  const outbox = new Outbox();
  const result = ctx.db.transaction((tx) => fn(tx, outbox), { behavior: 'immediate' });
  outbox.flush(ctx.bus);
  return result;
}
