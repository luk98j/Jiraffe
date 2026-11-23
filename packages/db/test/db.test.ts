import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_KEYS } from '@jiraffe/core';
import {
  countOpenRuns,
  finishRun,
  getTaskDto,
  hasFinishedAnalysis,
  insertEvent,
  insertMessage,
  insertRun,
  listMessages,
  listRuns,
  listUnprocessedEvents,
  markEventsProcessed,
  migrateDb,
  nextClaimCandidate,
  openDb,
  seedSettings,
  setRunPid,
  type Db,
} from '../src/index.ts';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jiraffe-db-'));
  db = openDb(join(dir, 'test.db'));
  migrateDb(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const raw = (d: Db) => d.$client;
const cols = (table: string) =>
  (raw(db).pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

describe('migrations (AC-6, AC-7)', () => {
  it('creates the seven tables with the section 3 columns', () => {
    expect(cols('tasks')).toEqual([
      'id',
      'source',
      'jira_key',
      'local_key',
      'title',
      'body',
      'repo_path',
      'status',
      'status_before_pause',
      'priority',
      'max_credits',
      'pause_reason',
      'resume_at',
      'jira_closed',
      'body_changed_after_analysis',
      'last_synced_at',
      'closed_in_jira_at',
      'deleted_at',
      'created_at',
      'updated_at',
    ]);
    expect(cols('messages')).toEqual([
      'id',
      'task_id',
      'role',
      'source',
      'content',
      'jira_comment_id',
      'created_at',
    ]);
    expect(cols('runs')).toEqual([
      'id',
      'task_id',
      'kind',
      'agent',
      'session_id',
      'status',
      'pid',
      'max_credits',
      'credits_used',
      'end_reason',
      'started_at',
      'finished_at',
      'result_json',
      'worktree_path',
      'branch',
      'base_commit',
    ]);
    expect(cols('events')).toEqual([
      'id',
      'task_id',
      'type',
      'payload_json',
      'processed_at',
      'created_at',
    ]);
    expect(cols('journal')).toEqual(['id', 'at', 'task_key', 'status', 'action', 'detail']);
    expect(cols('ignored_jira_keys')).toEqual(['jira_key', 'deleted_at']);
    expect(cols('settings')).toEqual(['key', 'value_json']);
  });

  it('uses WAL mode and enforces foreign keys', () => {
    expect(raw(db).pragma('journal_mode', { simple: true })).toBe('wal');
    expect(raw(db).pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is a no-op when run again', () => {
    const before = raw(db).prepare('SELECT * FROM __drizzle_migrations').all();
    expect(() => migrateDb(db)).not.toThrow();
    expect(raw(db).prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(before);
  });
});

describe('settings seed (AC-8, AC-9)', () => {
  const rows = () =>
    Object.fromEntries(
      (
        raw(db).prepare('SELECT key, value_json FROM settings').all() as {
          key: string;
          value_json: string;
        }[]
      ).map((r) => [r.key, JSON.parse(r.value_json)]),
    );

  it('seeds every key with its default', () => {
    seedSettings(db);
    const got = rows();
    expect(Object.keys(got).sort()).toEqual([...SETTING_KEYS].sort());
    for (const k of SETTING_KEYS) expect(got[k], k).toEqual(SETTINGS[k].default);
  });

  it('never overwrites a changed value and re-seeds a missing key', () => {
    seedSettings(db);
    raw(db)
      .prepare("UPDATE settings SET value_json = '3' WHERE key = 'max_parallel_analysis'")
      .run();
    raw(db).prepare("DELETE FROM settings WHERE key = 'retention_days'").run();
    seedSettings(db);
    expect(rows().max_parallel_analysis).toBe(3);
    expect(rows().retention_days).toBe(28);
  });
});

describe('task constraints (AC-30)', () => {
  const ins = (jira: string | null, local: string | null) =>
    raw(db)
      .prepare(
        `INSERT INTO tasks (source, jira_key, local_key, title, status, created_at, updated_at)
         VALUES (?, ?, ?, 't', 'new', 'x', 'x')`,
      )
      .run(jira ? 'jira' : 'local', jira, local);

  it('rejects a duplicate jira_key and a duplicate local_key', () => {
    ins('P-1', null);
    expect(() => ins('P-1', null)).toThrow(/UNIQUE/);
    ins(null, 'LOC-0001');
    expect(() => ins(null, 'LOC-0001')).toThrow(/UNIQUE/);
  });

  it('requires exactly one of jira_key and local_key', () => {
    expect(() => ins(null, null)).toThrow(/CHECK/);
    expect(() => ins('P-2', 'LOC-0002')).toThrow(/CHECK/);
  });

  it('rejects unknown status and source values', () => {
    expect(() =>
      raw(db)
        .prepare(
          `INSERT INTO tasks (source, local_key, title, status, created_at, updated_at)
           VALUES ('local', 'LOC-9', 't', 'bogus', 'x', 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('runs, claims and events helpers (step 5)', () => {
  const task = (
    status: string,
    over: { priority?: number; updatedAt?: string; deleted?: boolean } = {},
  ) =>
    Number(
      raw(db)
        .prepare(
          `INSERT INTO tasks (source, local_key, title, status, priority, deleted_at, created_at, updated_at)
           VALUES ('local', ?, 't', ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(
          `LOC-${Math.random().toString(36).slice(2, 8)}`,
          status,
          over.priority ?? 0,
          over.deleted ? '2026-01-02T00:00:00.000Z' : null,
          over.updatedAt ?? '2026-01-01T00:00:00.000Z',
        ).lastInsertRowid,
    );
  const run = (
    taskId: number,
    kind: 'analysis' | 'execution' = 'analysis',
    at = '2026-01-03T00:00:00.000Z',
  ) => insertRun(db, { taskId, kind, agent: 'copilot', maxCredits: 2, startedAt: at });

  it('inserts an open run, counts it per kind, and finishes it', () => {
    const t = task('analysing');
    const r = run(t);
    expect(countOpenRuns(db, 'analysis')).toBe(1);
    expect(countOpenRuns(db, 'execution')).toBe(0);
    setRunPid(db, r, 4242);
    expect(listRuns(db, t, 'analysis')[0]).toMatchObject({ id: r, status: 'running', pid: 4242 });
    finishRun(db, r, {
      endReason: 'completed',
      finishedAt: '2026-01-03T00:01:00.000Z',
      resultJson: '{"a":1}',
    });
    expect(countOpenRuns(db, 'analysis')).toBe(0);
    expect(listRuns(db, t, 'analysis')[0]).toMatchObject({
      status: 'finished',
      endReason: 'completed',
      pid: null,
      resultJson: '{"a":1}',
    });
  });

  it('claims queued tasks by priority, then updated_at, skipping deleted ones', () => {
    task('queued_analysis', { priority: 5, updatedAt: '2026-01-01T00:00:00.000Z' });
    const late = task('queued_analysis', { priority: 1, updatedAt: '2026-01-05T00:00:00.000Z' });
    const early = task('queued_analysis', { priority: 1, updatedAt: '2026-01-02T00:00:00.000Z' });
    task('queued_analysis', { priority: 0, deleted: true });
    expect(nextClaimCandidate(db, 'analysis')?.taskId).toBe(early);
    run(early);
    expect(nextClaimCandidate(db, 'analysis')?.taskId).toBe(late);
  });

  it('treats analysing or running tasks without an open run as orphans, and excludes tasks with one', () => {
    const a = task('analysing');
    const x = task('running');
    expect(nextClaimCandidate(db, 'analysis')).toMatchObject({ taskId: a, status: 'analysing' });
    expect(nextClaimCandidate(db, 'execution')).toMatchObject({ taskId: x, status: 'running' });
    run(a);
    expect(nextClaimCandidate(db, 'analysis')).toBeUndefined();
    const d = task('delegated', { priority: -1 });
    expect(nextClaimCandidate(db, 'execution')).toMatchObject({ taskId: d, status: 'delegated' });
  });

  it('hasNewComment compares against the start of the last completed analysis', () => {
    const t = task('ready_to_delegate');
    const msg = (at: string) =>
      insertMessage(db, { taskId: t, role: 'user', source: 'app', content: 'c', createdAt: at });
    const r = run(t, 'analysis', '2026-01-03T00:00:00.000Z');
    expect(getTaskDto(db, t)?.hasNewComment).toBe(false);
    msg('2026-01-03T00:00:30.000Z'); // arrived while the run was running
    finishRun(db, r, { endReason: 'completed', finishedAt: '2026-01-03T00:01:00.000Z' });
    expect(getTaskDto(db, t)?.hasNewComment).toBe(true);
    const r2 = run(t, 'analysis', '2026-01-03T00:02:00.000Z');
    finishRun(db, r2, { endReason: 'completed', finishedAt: '2026-01-03T00:03:00.000Z' });
    expect(getTaskDto(db, t)?.hasNewComment).toBe(false);
  });

  it('marks messages that arrived after the latest run started as waiting for the next run', () => {
    const t = task('analysing');
    const m = (at: string, role: 'user' | 'agent' = 'user') =>
      insertMessage(db, { taskId: t, role, source: 'app', content: at, createdAt: at });
    m('2026-01-02T00:00:00.000Z');
    run(t, 'analysis', '2026-01-03T00:00:00.000Z');
    m('2026-01-03T00:00:10.000Z');
    m('2026-01-03T00:00:20.000Z', 'agent');
    expect(listMessages(db, t).map((x) => x.waitsForNextRun)).toEqual([false, true, false]);
  });

  it('hasFinishedAnalysis means a completed analysis, not just a finished one', () => {
    const t = task('analysing');
    const r = run(t);
    expect(hasFinishedAnalysis(db, t)).toBe(false);
    finishRun(db, r, { endReason: 'crashed', finishedAt: '2026-01-03T00:01:00.000Z' });
    expect(hasFinishedAnalysis(db, t)).toBe(false);
    finishRun(db, run(t), { endReason: 'completed', finishedAt: '2026-01-03T00:05:00.000Z' });
    expect(hasFinishedAnalysis(db, t)).toBe(true);
  });

  it('lists unprocessed events in order and marks them processed', () => {
    const t = task('new');
    insertEvent(db, { taskId: t, type: 'enqueue', createdAt: 'a' });
    insertEvent(db, { taskId: t, type: 'agent_output', createdAt: 'b', processedAt: 'b' });
    insertEvent(db, { taskId: t, type: 'retry', createdAt: 'c' });
    const open = listUnprocessedEvents(db, 10);
    expect(open.map((e) => e.type)).toEqual(['enqueue', 'retry']);
    markEventsProcessed(
      db,
      open.map((e) => e.id),
      'now',
    );
    expect(listUnprocessedEvents(db, 10)).toEqual([]);
  });
});
