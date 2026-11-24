import {
  createClaudeRunner,
  createCopilotRunner,
  nodeSpawner,
  realGit,
  type AgentId,
  type AgentRunner,
  type GitRunner,
} from '@jiraffe/adapters';
import { listJournal, migrateDb, openDb, seedSettings } from '@jiraffe/db';
import type { JiraClient } from '@jiraffe/jira';
import { Bus, type Logger } from './bus.ts';
import type { Ctx } from './context.ts';
import { getSetting, readSettings, updateSetting } from './settings.ts';
import { canDelegate, delegate } from './delegate.ts';
import { getDiff, getLogs, removeWorktreeAndBranch } from './review.ts';
import { createWorkers } from './workers.ts';
import { createScheduler } from './scheduler.ts';
import { startEngine } from './start.ts';
import { runCommentSync, runTaskSync } from './sync.ts';
import { runRetention } from './retention.ts';
import { addUserMessage, listMessages } from './messages.ts';
import { transition } from './transition.ts';
import {
  createLocalTask,
  deleteTask,
  getTask,
  getTaskDetail,
  listDeleted,
  listTasks,
  restoreTask,
  setRepository,
} from './tasks.ts';

export { Bus, type DomainEvent, type Logger } from './bus.ts';
export type { Ctx } from './context.ts';

export interface EngineOptions {
  dbPath: string;
  version: string;
  jiraClient?: JiraClient;
  clock?: () => Date;
  logger?: Logger;
  /** Agent adapters by id; tests pass fakes. Defaults to the Copilot CLI adapter. */
  runners?: Partial<Record<AgentId, AgentRunner>>;
  git?: GitRunner;
}

export function createEngine(opts: EngineOptions) {
  const logger = opts.logger ?? {
    error: (m, e) => console.error(m, e instanceof Error ? e.message : ''),
  };
  const db = openDb(opts.dbPath);
  migrateDb(db);
  seedSettings(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(logger),
    clock: opts.clock ?? (() => new Date()),
    logger,
    sync: {
      inFlight: false,
      state: {
        state: 'idle',
        lastRunAt: null,
        lastError: null,
        lastSkippedAt: null,
        lastResult: null,
      },
    },
    version: opts.version,
    runners: opts.runners ?? {
      copilot: createCopilotRunner(nodeSpawner),
      claude: createClaudeRunner(nodeSpawner),
    },
    git: opts.git ?? realGit,
    workers: undefined as never, // assigned right below, once the context exists
    ...(opts.jiraClient ? { jiraClient: opts.jiraClient } : {}),
  };
  ctx.workers = createWorkers(ctx);
  ctx.bus.onEvent((e) =>
    e.type === 'cancel' ? ctx.workers.abort(e.taskId, 'cancelled') : ctx.workers.pump(),
  );
  const scheduler = createScheduler(ctx);
  return {
    /** Internal context, exposed for engine tests only; the server must not use it. */
    ctx,
    bus: ctx.bus,
    readSettings: () => readSettings(ctx),
    getSetting: <K extends Parameters<typeof getSetting>[1]>(key: K) => getSetting(ctx, key),
    updateSetting(key: string, value: unknown) {
      updateSetting(ctx, key, value);
      ctx.workers.pump(); // a changed limit or auto_analysis may let queued tasks start
    },
    transition: (
      ...args: Parameters<typeof transition> extends [unknown, ...infer R] ? R : never
    ) => transition(ctx, ...args),
    createLocalTask: (input: Parameters<typeof createLocalTask>[1]) => createLocalTask(ctx, input),
    setRepository: (id: number, path: string) => setRepository(ctx, id, path),
    deleteTask: (id: number) => deleteTask(ctx, id),
    restoreTask: (id: number) => restoreTask(ctx, id),
    addUserMessage: (id: number, content: string) => addUserMessage(ctx, id, content),
    listMessages: (id: number) => listMessages(ctx, id),
    runRetention: (now?: Date) => runRetention(ctx, now),
    runTaskSync: () => runTaskSync(ctx),
    runCommentSync: () => runCommentSync(ctx),
    syncState: () => ({ ...ctx.sync.state }),
    /** "Start queue": lets workers start queued analyses for this session. */
    startQueue() {
      ctx.workers.queueStarted = true;
      ctx.workers.pump();
    },
    queueState: () => ctx.workers.queueState(),
    canDelegate: (id: number) => canDelegate(ctx, id),
    delegate: (id: number) => delegate(ctx, id),
    getLogs: (id: number, after: number, limit: number) => getLogs(ctx, id, after, limit),
    getDiff: (id: number) => getDiff(ctx, id),
    removeWorktreeAndBranch: (id: number) => removeWorktreeAndBranch(ctx, id),
    /** Resolves when no run is live (tests and shutdown). */
    idle: () => ctx.workers.idle(),
    version: opts.version,
    listTasks: () => listTasks(ctx),
    listDeleted: () => listDeleted(ctx),
    getTaskDetail: (id: number) => getTaskDetail(ctx, id),
    getTask: (id: number) => getTask(ctx, id),
    listJournal: (f: { taskKey?: string; action?: string; limit?: number }) => listJournal(db, f),
    async start() {
      await startEngine(ctx);
      scheduler.start();
    },
    stop: () => scheduler.stop(),
    close() {
      scheduler.stop();
      ctx.workers.close();
      db.$client.close();
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
