import Fastify from 'fastify';
import { HOST, getPort } from './config.ts';

export function buildServer(opts: { version: string }) {
  const app = Fastify();
  app.get('/api/health', async () => ({ ok: true, version: opts.version }));
  return app;
}

export async function listen(
  app: ReturnType<typeof buildServer>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await app.listen({ host: HOST, port: getPort(env) });
}
