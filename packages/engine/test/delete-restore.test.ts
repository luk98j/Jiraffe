import { afterEach, describe, expect, it } from 'vitest';
import { ConflictError, STATUSES, TaskNotFoundError } from '@jiraffe/core';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import { disposeAll, makeEngine, newTaskIn } from './helpers.ts';

afterEach(disposeAll);

const NOW = '2026-11-21T10:00:00.000Z';

describe('delete (AC-51, AC-52)', () => {
  it.each(STATUSES.filter((s) => s !== 'running'))('soft-deletes a task in %s', (status) => {
    const jira = new FakeJiraClient();
    const h = makeEngine({ jiraClient: jira, clock: () => new Date(NOW) });
    const id = newTaskIn(h.engine, status);
    const before = h.engine.getTask(id);
    h.engine.deleteTask(id);
    const after = h.engine.getTask(id);
    expect(after.deletedAt).toBe(NOW);
    expect(after.status).toBe(status);
    expect(after.statusBeforePause).toBe(before.statusBeforePause);
    expect(h.engine.listJournal({ action: 'task_deleted' })).toEqual([
      expect.objectContaining({ taskKey: 'LOC-0001', status, detail: null, at: NOW }),
    ]);
    expect(jira.calls).toEqual([]);
  });

  it('rejects a running task with a readable reason', () => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'running');
    const journal = h.engine.listJournal({}).length;
    expect(() => h.engine.deleteTask(id)).toThrow(ConflictError);
    expect(() => h.engine.deleteTask(id)).toThrow('Cancel the task first');
    expect(h.engine.getTask(id).deletedAt).toBeNull();
    expect(h.engine.listJournal({})).toHaveLength(journal);
  });

  it('rejects unknown and already deleted tasks without writing', () => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'new');
    expect(() => h.engine.deleteTask(999)).toThrow(TaskNotFoundError);
    h.engine.deleteTask(id);
    const journal = h.engine.listJournal({}).length;
    expect(() => h.engine.deleteTask(id)).toThrow(TaskNotFoundError);
    expect(h.engine.listJournal({})).toHaveLength(journal);
  });
});

describe('restore (AC-53)', () => {
  it('clears deleted_at, keeps status and status_before_pause, and journals', () => {
    const h = makeEngine({ clock: () => new Date(NOW) });
    const id = newTaskIn(h.engine, 'paused_quota', 'running');
    h.engine.deleteTask(id);
    h.engine.restoreTask(id);
    expect(h.engine.getTask(id)).toMatchObject({
      deletedAt: null,
      status: 'paused_quota',
      statusBeforePause: 'running',
    });
    expect(h.engine.listJournal({ action: 'task_restored' })).toEqual([
      expect.objectContaining({ taskKey: 'LOC-0001', status: 'paused_quota' }),
    ]);
  });

  it('errors and writes nothing for a non-deleted or unknown task', () => {
    const h = makeEngine();
    const id = newTaskIn(h.engine, 'new');
    const journal = h.engine.listJournal({}).length;
    expect(() => h.engine.restoreTask(id)).toThrow(ConflictError);
    expect(() => h.engine.restoreTask(999)).toThrow(TaskNotFoundError);
    expect(h.engine.listJournal({})).toHaveLength(journal);
  });
});
