import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Engine } from '@jiraffe/engine';

const PING_MS = 15_000;

/** Server-sent events: one `change` message per committed change; the UI refetches. */
export function registerSse(app: FastifyInstance, engine: Engine): void {
  const streams = new Map<ServerResponse, () => void>();

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    res.write('retry: 2000\n\n');
    const off = engine.bus.onChanged(() => {
      res.write(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();
    const cleanup = () => {
      clearInterval(ping);
      off();
      streams.delete(res);
    };
    streams.set(res, cleanup);
    req.raw.on('close', cleanup);
  });

  app.addHook('preClose', async () => {
    for (const [res, cleanup] of streams) {
      cleanup();
      res.end();
    }
  });
}
