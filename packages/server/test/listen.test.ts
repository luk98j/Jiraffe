import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from '@jiraffe/engine';
import { buildServer, getPort, listen, HOST } from '../src/index.ts';

const newApp = () => buildServer(createEngine({ dbPath: ':memory:', version: '1.2.3', logger: { error() {} } }));

let app: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('server listening (AC-4)', () => {
  it('binds to 127.0.0.1 only', async () => {
    app = newApp();
    await listen(app, { JIRAFFE_PORT: '0' });
    const addr = app.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.address).not.toBe('0.0.0.0');
    expect(HOST).toBe('127.0.0.1');
  });

  it('ignores any host override from the environment', async () => {
    app = newApp();
    await listen(app, { JIRAFFE_PORT: '0', JIRAFFE_HOST: '0.0.0.0', HOST: '0.0.0.0' });
    expect((app.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('reads the port from JIRAFFE_PORT with 4317 as default', () => {
    expect(getPort({})).toBe(4317);
    expect(getPort({ JIRAFFE_PORT: '5000' })).toBe(5000);
    expect(() => getPort({ JIRAFFE_PORT: 'abc' })).toThrow(/JIRAFFE_PORT/);
  });

  it('serves the health route', async () => {
    app = newApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '1.2.3' });
  });
});
