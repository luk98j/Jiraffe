import { afterEach, describe, expect, it } from 'vitest';
import { STATUSES, TaskNotFoundError, ValidationError } from '@jiraffe/core';
import { disposeAll, makeEngine, newTaskIn } from './helpers.ts';

afterEach(disposeAll);

const NOW = '2026-11-21T10:00:00.000Z';
const rows = (h: ReturnType<typeof makeEngine>) => ({
  messages: h.raw.prepare('SELECT * FROM messages').all(),
  events: h.raw.prepare('SELECT * FROM events').all(),
  journal: h.raw.prepare('SELECT * FROM journal').all(),
});

describe('user message on a waiting_user task (AC-18)', () => {
  it('saves the message, writes both events in order, moves to queued_analysis and journals', () => {
    const h = makeEngine({ clock: () => new Date(NOW) });
    const id = newTaskIn(h.engine, 'waiting_user');
    const events0 = (h.raw.prepare('SELECT count(*) c FROM events').get() as { c: number }).c;
    const journal0 = h.engine.listJournal({}).length;
    h.engine.addUserMessage(id, '  my answer  ');

    expect(h.engine.getTask(id).status).toBe('queued_analysis');
    expect(h.engine.listMessages(id)).toEqual([
      expect.objectContaining({
        role: 'user',
        source: 'app',
        content: 'my answer',
        createdAt: NOW,
      }),
    ]);
    const ev = h.raw.prepare('SELECT type FROM events ORDER BY id').all() as { type: string }[];
    expect(ev.slice(events0).map((e) => e.type)).toEqual(['user_comment', 'user_answered']);
    const journal = h.engine.listJournal({});
    expect(journal).toHaveLength(journal0 + 2);
    expect(journal.slice(0, 2).map((j) => [j.action, j.status, j.detail])).toEqual([
      ['comment_added', 'queued_analysis', 'source: app'],
      ['status_changed', 'queued_analysis', 'waiting_user to queued_analysis'],
    ]);
    expect(JSON.stringify(journal)).not.toContain('my answer');
  });

  it('notifies the bus only after commit', () => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'waiting_user');
    const types: string[] = [];
    h.engine.bus.onEvent((e) => types.push(e.type));
    h.engine.addUserMessage(id, 'x');
    expect(types).toEqual(['user_comment', 'user_answered']);
  });
});

describe('user message in any other status (AC-19)', () => {
  it.each(STATUSES.filter((s) => s !== 'waiting_user'))('%s keeps its status', (status) => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, status);
    const events0 = (h.raw.prepare('SELECT count(*) c FROM events').get() as { c: number }).c;
    h.engine.addUserMessage(id, 'hello');
    expect(h.engine.getTask(id).status).toBe(status);
    expect(h.engine.listMessages(id)).toHaveLength(1);
    const ev = h.raw.prepare('SELECT type FROM events ORDER BY id').all() as { type: string }[];
    expect(ev.slice(events0).map((e) => e.type)).toEqual(['user_comment']);
    expect(h.engine.listJournal({})[0]).toMatchObject({
      action: 'comment_added',
      status,
      detail: 'source: app',
    });
  });
});

describe('rejections (AC-80)', () => {
  it('rejects an unknown or soft-deleted task and writes nothing', () => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'new');
    h.engine.deleteTask(id);
    const before = rows(h);
    expect(() => h.engine.addUserMessage(id, 'x')).toThrow(TaskNotFoundError);
    expect(() => h.engine.addUserMessage(999, 'x')).toThrow(TaskNotFoundError);
    expect(rows(h)).toEqual(before);
  });

  it.each(['', '   ', '\n\t'])('rejects empty content %j', (content) => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'new');
    const before = rows(h);
    expect(() => h.engine.addUserMessage(id, content)).toThrow(ValidationError);
    expect(rows(h)).toEqual(before);
  });
});
