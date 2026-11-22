import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SETTINGS, SETTING_KEYS } from '@jiraffe/core';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Opens (and creates) the SQLite file. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
}

/** Inserts every missing setting with its default; never overwrites. */
export function seedSettings(db: Db): void {
  const stmt = db.$client.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  db.$client.transaction(() => {
    for (const key of SETTING_KEYS) stmt.run(key, JSON.stringify(SETTINGS[key].default));
  })();
}
