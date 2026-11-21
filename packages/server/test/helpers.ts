import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@jiraffe/engine';
import { buildServer } from '../src/index.ts';

export interface Harness {
  engine: Engine;
  app: ReturnType<typeof buildServer>;
  /** Raw SQL handle for tests only. */
  raw: Engine['ctx']['db']['$client'];
  req(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }>;
  dispose(): Promise<void>;
}

const open: Harness[] = [];

export function makeApp(opts: Partial<Parameters<typeof createEngine>[0]> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'jiraffe-server-'));
  const engine = createEngine({ dbPath: join(dir, 'test.db'), version: '1.2.3', logger: { error() {} }, ...opts });
  const app = buildServer(engine);
  const h: Harness = {
    engine,
    app,
    raw: engine.ctx.db.$client,
    async req(method, url, body) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { host: '127.0.0.1:4317' },
        ...(body === undefined ? {} : { payload: body as object }),
      });
      let parsed: unknown = null;
      try {
        parsed = res.body ? JSON.parse(res.body) : null;
      } catch {
        parsed = res.body;
      }
      return { status: res.statusCode, body: parsed };
    },
    async dispose() {
      await app.close();
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  open.push(h);
  return h;
}

export async function disposeAll(): Promise<void> {
  for (const h of open.splice(0)) await h.dispose();
}
