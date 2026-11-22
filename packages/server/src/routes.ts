import type { FastifyInstance } from 'fastify';
import { ValidationError, type TransitionEvent } from '@jiraffe/core';
import type { Engine } from '@jiraffe/engine';

// Events the UI may send. Everything else is driven by workers and sync.
const UI_EVENTS: readonly string[] = [
  'enqueue',
  'cancel',
  'reanalyse',
  'retry',
  'resume',
  'review_accepted',
];

const obj = (b: unknown): Record<string, unknown> =>
  b && typeof b === 'object' ? (b as Record<string, unknown>) : {};

function idOf(params: unknown): number {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('Invalid task id', 'id');
  return id;
}

function text(b: Record<string, unknown>, field: string, label: string, required = true): string {
  const v = b[field];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && !v.trim()))
    throw new ValidationError(`${label} is required`, field);
  return v;
}

export function registerRoutes(app: FastifyInstance, engine: Engine): void {
  app.get('/api/health', async () => ({ ok: true, version: engine.version }));

  app.get('/api/tasks', async () => ({ tasks: engine.listTasks() }));

  app.post('/api/tasks', async (req, reply) => {
    const b = obj(req.body);
    const task = engine.createLocalTask({
      title: text(b, 'title', 'Title'),
      description: text(b, 'description', 'Description', false),
      repoPath: text(b, 'repoPath', 'Repository'),
    });
    return reply.code(201).send({ task });
  });

  app.get('/api/tasks/:id', async (req) => engine.getTaskDetail(idOf(req.params)));

  app.patch('/api/tasks/:id', async (req) => {
    const id = idOf(req.params);
    engine.setRepository(id, text(obj(req.body), 'repoPath', 'Repository'));
    return { task: engine.getTask(id) };
  });

  app.post('/api/tasks/:id/events', async (req) => {
    const id = idOf(req.params);
    const event = obj(req.body).event;
    if (typeof event !== 'string' || !UI_EVENTS.includes(event)) {
      throw new ValidationError('Unsupported event', 'event');
    }
    engine.transition(id, event as TransitionEvent);
    return { task: engine.getTask(id) };
  });

  app.post('/api/tasks/:id/messages', async (req, reply) => {
    const id = idOf(req.params);
    engine.addUserMessage(id, text(obj(req.body), 'content', 'Message'));
    return reply.code(201).send(engine.getTaskDetail(id));
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    engine.deleteTask(idOf(req.params));
    return reply.code(204).send();
  });

  app.post('/api/tasks/:id/restore', async (req) => {
    const id = idOf(req.params);
    engine.restoreTask(id);
    return { task: engine.getTask(id) };
  });

  app.get('/api/deleted', async () => ({ tasks: engine.listDeleted() }));

  app.get('/api/journal', async (req) => {
    const q = req.query as { taskKey?: string; action?: string; limit?: string };
    let limit: number | undefined;
    if (q.limit !== undefined) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1)
        throw new ValidationError('Invalid limit', 'limit');
    }
    return {
      entries: engine.listJournal({
        ...(q.taskKey ? { taskKey: q.taskKey } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(limit ? { limit } : {}),
      }),
    };
  });

  app.get('/api/settings', async () => engine.readSettings());

  app.put('/api/settings/:key', async (req) => {
    const b = obj(req.body);
    if (!('value' in b)) throw new ValidationError('A value is required', 'value');
    engine.updateSetting((req.params as { key: string }).key, b.value);
    return engine.readSettings();
  });

  app.get('/api/sync', async () => engine.syncState());

  app.post('/api/sync', async () => engine.runTaskSync());
}
