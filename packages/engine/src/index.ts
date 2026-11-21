import { listJournal, migrateDb, openDb, seedSettings } from '@jiraffe/db';
import type { JiraClient } from '@jiraffe/jira';
import { Bus, type Logger } from './bus.ts';
import type { Ctx } from './context.ts';
import { getSetting, readSettings, updateSetting } from './settings.ts';
import { createLocalTask, getTask, setRepository } from './tasks.ts';

export { Bus, type DomainEvent, type Logger } from './bus.ts';
export type { Ctx } from './context.ts';

export interface EngineOptions {
  dbPath: string;
  version: string;
  jiraClient?: JiraClient;
  clock?: () => Date;
  logger?: Logger;
}

export function createEngine(opts: EngineOptions) {
  const logger = opts.logger ?? { error: (m, e) => console.error(m, e instanceof Error ? e.message : '') };
  const db = openDb(opts.dbPath);
  migrateDb(db);
  seedSettings(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(logger),
    clock: opts.clock ?? (() => new Date()),
    logger,
    version: opts.version,
    ...(opts.jiraClient ? { jiraClient: opts.jiraClient } : {}),
  };
  return {
    /** Internal context, exposed for engine tests only; the server must not use it. */
    ctx,
    bus: ctx.bus,
    readSettings: () => readSettings(ctx),
    getSetting: <K extends Parameters<typeof getSetting>[1]>(key: K) => getSetting(ctx, key),
    updateSetting: (key: string, value: unknown) => updateSetting(ctx, key, value),
    createLocalTask: (input: Parameters<typeof createLocalTask>[1]) => createLocalTask(ctx, input),
    setRepository: (id: number, path: string) => setRepository(ctx, id, path),
    getTask: (id: number) => getTask(ctx, id),
    listJournal: (f: { taskKey?: string; action?: string; limit?: number }) => listJournal(db, f),
    close: () => db.$client.close(),
  };
}

export type Engine = ReturnType<typeof createEngine>;
