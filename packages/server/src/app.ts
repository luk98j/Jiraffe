import Fastify from 'fastify';
import { AppError, type ApiError } from '@jiraffe/core';
import type { Engine } from '@jiraffe/engine';
import { HOST, getPort } from './config.ts';
import { registerRoutes } from './routes.ts';
import { registerSse } from './sse.ts';

const STATUS: Record<string, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  not_ready: 409,
};

export function buildServer(engine: Engine) {
  const app = Fastify();

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      const body: ApiError = {
        error: { code: err.code, message: err.message, ...('field' in err && err.field ? { field: err.field as string } : {}) },
      };
      return reply.code(STATUS[err.code] ?? 400).send(body);
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid request' } } satisfies ApiError);
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } } satisfies ApiError);
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } } satisfies ApiError),
  );

  registerRoutes(app, engine);
  registerSse(app, engine);
  return app;
}

export async function listen(
  app: ReturnType<typeof buildServer>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await app.listen({ host: HOST, port: getPort(env) });
}
