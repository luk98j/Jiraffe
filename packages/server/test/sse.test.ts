import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/index.ts';
import { disposeAll, makeApp } from './helpers.ts';

afterEach(disposeAll);

function connect(port: number) {
  return new Promise<{
    res: IncomingMessage;
    chunks: string[];
    closed: Promise<void>;
    destroy(): void;
  }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
      const closed = new Promise<void>((r) => res.on('close', () => r()));
      resolve({ res, chunks, closed, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('SSE stream (AC-69)', () => {
  it('delivers a change event to a second client within 2 seconds', async () => {
    const h = makeApp();
    await listen(h.app, { JIRAFFE_PORT: '0' });
    const port = (h.app.server.address() as AddressInfo).port;
    const a = await connect(port);
    const b = await connect(port);
    expect(b.res.headers['content-type']).toContain('text/event-stream');
    expect(b.res.headers['cache-control']).toBe('no-cache');
    await until(() => b.chunks.join('').includes('retry: 2000'));

    const t = h.engine.createLocalTask({ title: 'x', description: '', repoPath: '/r' });
    await h.req('POST', `/api/tasks/${t.id}/events`, { event: 'enqueue' });
    await until(() => b.chunks.join('').includes('event: change'));
    expect(b.chunks.join('')).toMatch(/event: change\ndata: \{"at":"[^"]+"\}\n\n/);
    a.destroy();
    b.destroy();
  });

  it('removes the listener when a client disconnects', async () => {
    const h = makeApp();
    await listen(h.app, { JIRAFFE_PORT: '0' });
    const port = (h.app.server.address() as AddressInfo).port;
    const base = h.engine.bus.listenerCount('changed');
    const c = await connect(port);
    await until(() => c.chunks.join('').includes('retry'));
    expect(h.engine.bus.listenerCount('changed')).toBe(base + 1);
    c.destroy();
    await until(() => h.engine.bus.listenerCount('changed') === base);
  });

  it('ends open streams when the server closes', async () => {
    const h = makeApp();
    await listen(h.app, { JIRAFFE_PORT: '0' });
    const c = await connect((h.app.server.address() as AddressInfo).port);
    await until(() => c.chunks.join('').includes('retry'));
    await h.app.close();
    await c.closed;
    expect(h.engine.bus.listenerCount('changed')).toBe(0);
  });
});
