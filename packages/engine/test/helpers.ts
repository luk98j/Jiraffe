import { expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@jiraffe/db';
import { createEngine, type Engine } from '../src/index.ts';

export interface Harness {
  engine: Engine;
  /** A second connection to the same file, for raw SQL in tests only. */
  raw: Db['$client'];
  path: string;
  dispose(): void;
}

const open: Harness[] = [];

export function makeEngine(opts: Partial<Parameters<typeof createEngine>[0]> = {}, dir?: string): Harness {
  const folder = dir ?? mkdtempSync(join(tmpdir(), 'jiraffe-engine-'));
  const path = join(folder, 'test.db');
  const engine = createEngine({ dbPath: path, version: 'test', logger: { error() {} }, ...opts });
  const second = openDb(path);
  const h: Harness = {
    engine,
    raw: second.$client,
    path,
    dispose() {
      second.$client.close();
      engine.close();
      if (!dir) rmSync(folder, { recursive: true, force: true });
    },
  };
  open.push(h);
  return h;
}

export function disposeAll(): void {
  for (const h of open.splice(0)) h.dispose();
}

const PATHS: Record<string, string[]> = {
  new: [],
  queued_analysis: ['enqueue'],
  analysing: ['enqueue', 'analysis_started'],
  waiting_user: ['enqueue', 'analysis_started', 'analysis_needs_info'],
  ready_to_delegate: ['enqueue', 'analysis_started', 'analysis_ready'],
  delegated: ['enqueue', 'analysis_started', 'analysis_ready', 'delegate'],
  running: ['enqueue', 'analysis_started', 'analysis_ready', 'delegate', 'execution_started'],
  review: ['enqueue', 'analysis_started', 'analysis_ready', 'delegate', 'execution_started', 'execution_done'],
  done: ['enqueue', 'analysis_started', 'analysis_ready', 'delegate', 'execution_started', 'execution_done', 'review_accepted'],
  failed: ['enqueue', 'analysis_started', 'failed'],
  paused_quota: ['enqueue', 'analysis_started', 'quota'],
  cancelled: ['cancel'],
};

/** Creates a local task and walks it to `status` through real transitions. */
export function newTaskIn(engine: Engine, status: string, pausedFrom: 'analysing' | 'running' = 'analysing'): number {
  const task = engine.createLocalTask({ title: 'T', description: 'D', repoPath: '/repos/a' });
  const path =
    status === 'paused_quota' && pausedFrom === 'running'
      ? [...PATHS.running!, 'credit_limit']
      : PATHS[status];
  if (!path) throw new Error(`unknown status ${status}`);
  for (const event of path) engine.transition(task.id, event as never);
  expect(engine.getTask(task.id).status).toBe(status);
  return task.id;
}

/** Inserts a task row by raw SQL for states that cannot be reached legitimately. */
export function rawTask(
  raw: Harness['raw'],
  f: {
    jiraKey?: string;
    localKey?: string;
    status?: string;
    deletedAt?: string | null;
    closedInJiraAt?: string | null;
    jiraClosed?: boolean;
    title?: string;
    body?: string;
  },
): number {
  const jira = f.jiraKey !== undefined;
  const r = raw
    .prepare(
      `INSERT INTO tasks (source, jira_key, local_key, title, body, status, deleted_at, closed_in_jira_at, jira_closed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      jira ? 'jira' : 'local',
      f.jiraKey ?? null,
      jira ? null : (f.localKey ?? 'LOC-9000'),
      f.title ?? 'T',
      f.body ?? '',
      f.status ?? 'new',
      f.deletedAt ?? null,
      f.closedInJiraAt ?? null,
      f.jiraClosed || f.closedInJiraAt ? 1 : 0,
    );
  return Number(r.lastInsertRowid);
}

/** Adds a message, run, event and journal row to a task by raw SQL. */
export function rawChildren(raw: Harness['raw'], taskId: number, key: string): void {
  raw.prepare("INSERT INTO messages (task_id, role, source, content, created_at) VALUES (?, 'user', 'app', 'm', 'x')").run(taskId);
  raw.prepare("INSERT INTO runs (task_id, kind) VALUES (?, 'analysis')").run(taskId);
  raw.prepare("INSERT INTO events (task_id, type, created_at) VALUES (?, 'enqueue', 'x')").run(taskId);
  raw.prepare("INSERT INTO journal (at, task_key, status, action) VALUES ('2026-01-01T00:00:00.000Z', ?, 'new', 'task_created')").run(key);
}
