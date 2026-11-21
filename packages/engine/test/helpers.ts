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
