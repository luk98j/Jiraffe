import type { Db, Tx } from '@jiraffe/db';
import type { JiraClient } from '@jiraffe/jira';
import type { SyncStateDto } from '@jiraffe/core';
import type { AgentId, AgentRunner, GitRunner } from '@jiraffe/adapters';
import type { Bus, DomainEvent, Logger } from './bus.ts';
import type { Workers } from './workers.ts';

export interface Ctx {
  db: Db;
  bus: Bus;
  clock: () => Date;
  logger: Logger;
  version: string;
  jiraClient?: JiraClient;
  runners: Partial<Record<AgentId, AgentRunner>>;
  git: GitRunner;
  workers: Workers;
  /** Mutable in-memory sync state shared by task and comment sync. */
  sync: { state: SyncStateDto; inFlight: boolean };
}

/** Collects notifications during a transaction; they are sent only after commit. */
export class Outbox {
  private events: DomainEvent[] = [];
  private dirty = false;
  private logged = new Set<number>();

  emitEvent(e: DomainEvent): void {
    this.events.push(e);
  }

  changed(): void {
    this.dirty = true;
  }

  /** Output was stored for this task; sent as the `log` topic, not as a board-wide change. */
  log(taskId: number): void {
    this.logged.add(taskId);
  }

  flush(bus: Bus): void {
    for (const e of this.events) bus.emitEvent(e);
    for (const id of this.logged) bus.emitLog(id);
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
