import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/index.ts';
import { disposeAll, makeApp } from './helpers.ts';

afterEach(disposeAll);

const inject = (
  h: ReturnType<typeof makeApp>,
  method: string,
  url: string,
  headers: Record<string, string>,
) => h.app.inject({ method: method as 'GET', url, headers });

describe('Host and Origin guard (B-SEC-1)', () => {
  it.each([
    'evil.example:4317',
    'evil.example',
    'localhost',
    'localhost:9999',
    '127.0.0.1.evil.com:4317',
    '127.0.0.1:4317.evil.com',
    '',
  ])('rejects Host "%s" with 403', async (host) => {
    const h = makeApp();
    const res = await inject(h, 'GET', '/api/health', { host });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it.each(['127.0.0.1:4317', 'localhost:4317', 'LOCALHOST:4317'])(
    'accepts Host %s',
    async (host) => {
      const h = makeApp();
      expect((await inject(h, 'GET', '/api/health', { host })).statusCode).toBe(200);
    },
  );

  it.each([
    'http://evil.example',
    'null',
    'http://localhost:9999',
    'https://localhost:4317',
    'http://127.0.0.1:4317.evil.com',
  ])('rejects Origin %s on reads and writes', async (origin) => {
    const h = makeApp();
    const headers = { host: '127.0.0.1:4317', origin };
    expect((await inject(h, 'GET', '/api/health', headers)).statusCode).toBe(403);
    expect((await inject(h, 'PUT', '/api/settings/jira_base_url', headers)).statusCode).toBe(403);
    expect((await inject(h, 'POST', '/api/sync', headers)).statusCode).toBe(403);
    expect(h.engine.getSetting('jira_base_url')).toBe('');
  });

  it.each(['http://127.0.0.1:4317', 'http://localhost:4317'])(
    'accepts the same-origin Origin %s, and a request without Origin',
    async (origin) => {
      const h = makeApp();
      expect(
        (await inject(h, 'GET', '/api/health', { host: '127.0.0.1:4317', origin })).statusCode,
      ).toBe(200);
      expect((await inject(h, 'GET', '/api/health', { host: '127.0.0.1:4317' })).statusCode).toBe(
        200,
      );
    },
  );

  it('guards the queue routes too', async () => {
    const h = makeApp();
    for (const [method, url] of [
      ['GET', '/api/queue'],
      ['POST', '/api/queue/start'],
    ] as const) {
      expect((await inject(h, method, url, { host: 'evil.example' })).statusCode, url).toBe(403);
      const origin = { host: '127.0.0.1:4317', origin: 'http://evil.example' };
      expect((await inject(h, method, url, origin)).statusCode, url).toBe(403);
    }
    expect(h.engine.queueState().started).toBe(false);
  });

  it('guards unknown routes too', async () => {
    const h = makeApp();
    expect((await inject(h, 'GET', '/api/nope', { host: 'evil.example' })).statusCode).toBe(403);
  });
});

describe('guard on the real listener and the SSE route', () => {
  function get(port: number, headers: Record<string, string>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/stream', headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        if (res.statusCode === 200) {
          res.destroy();
          resolve({ status: 200, body: '' });
        }
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('uses the actual listening port and rejects a bad Host or Origin on /api/stream', async () => {
    const h = makeApp();
    await listen(h.app, { JIRAFFE_PORT: '0' });
    const port = (h.app.server.address() as AddressInfo).port;
    expect((await get(port, { host: 'evil.example' })).status).toBe(403);
    expect(
      (await get(port, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' })).status,
    ).toBe(403);
    expect((await get(port, { host: `localhost:${port}` })).status).toBe(200);
    expect(
      (await get(port, { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` })).status,
    ).toBe(200);
  });
});
