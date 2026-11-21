import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_KEYS } from '@jiraffe/core';
import { migrateDb, openDb, seedSettings, type Db } from '../src/index.ts';

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
      'id', 'source', 'jira_key', 'local_key', 'title', 'body', 'repo_path', 'status',
      'status_before_pause', 'priority', 'max_credits', 'pause_reason', 'resume_at', 'jira_closed',
      'body_changed_after_analysis', 'last_synced_at', 'closed_in_jira_at', 'deleted_at',
      'created_at', 'updated_at',
    ]);
    expect(cols('messages')).toEqual([
      'id', 'task_id', 'role', 'source', 'content', 'jira_comment_id', 'created_at',
    ]);
    expect(cols('runs')).toEqual([
      'id', 'task_id', 'kind', 'agent', 'session_id', 'status', 'pid', 'max_credits',
      'credits_used', 'end_reason', 'started_at', 'finished_at',
    ]);
    expect(cols('events')).toEqual(['id', 'task_id', 'type', 'payload_json', 'processed_at', 'created_at']);
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
      (raw(db).prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]).map(
        (r) => [r.key, JSON.parse(r.value_json)],
      ),
    );

  it('seeds every key with its default', () => {
    seedSettings(db);
    const got = rows();
    expect(Object.keys(got).sort()).toEqual([...SETTING_KEYS].sort());
    for (const k of SETTING_KEYS) expect(got[k], k).toEqual(SETTINGS[k].default);
  });

  it('never overwrites a changed value and re-seeds a missing key', () => {
    seedSettings(db);
    raw(db).prepare("UPDATE settings SET value_json = '3' WHERE key = 'max_parallel_analysis'").run();
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
