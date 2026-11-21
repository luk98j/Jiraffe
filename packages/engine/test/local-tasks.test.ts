import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@jiraffe/core';
import { disposeAll, makeEngine } from './helpers.ts';

afterEach(disposeAll);

const input = { title: 'Do it', description: 'Some text', repoPath: '/repos/a' };
const counts = (raw: ReturnType<typeof makeEngine>['raw']) => ({
  tasks: (raw.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c,
  journal: (raw.prepare('SELECT count(*) c FROM journal').get() as { c: number }).c,
});

describe('local tasks (AC-46)', () => {
  it('creates LOC-0001 with all fields, counter 1 and a task_created row', () => {
    const { engine, raw } = makeEngine({ clock: () => new Date('2026-11-21T10:00:00.000Z') });
    const task = engine.createLocalTask(input);
    expect(task).toMatchObject({
      key: 'LOC-0001',
      localKey: 'LOC-0001',
      jiraKey: null,
      source: 'local',
      status: 'new',
      title: 'Do it',
      body: 'Some text',
      repoPath: '/repos/a',
      deletedAt: null,
      createdAt: '2026-11-21T10:00:00.000Z',
    });
    expect(engine.getSetting('local_task_counter')).toBe(1);
    expect(engine.listJournal({})).toEqual([
      expect.objectContaining({
        action: 'task_created',
        taskKey: 'LOC-0001',
        status: 'new',
        detail: 'manual',
      }),
    ]);
    expect(raw.prepare('SELECT status FROM tasks').all()).toEqual([{ status: 'new' }]);
  });

  it('accepts an empty description', () => {
    const { engine } = makeEngine();
    expect(engine.createLocalTask({ ...input, description: '' }).body).toBe('');
  });
});

describe('numbering (AC-47, AC-48)', () => {
  it('never reuses numbers after a soft delete or a purge', () => {
    const { engine, raw } = makeEngine();
    engine.createLocalTask(input);
    const t2 = engine.createLocalTask(input);
    const t3 = engine.createLocalTask(input);
    raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', t2.id);
    raw.prepare('DELETE FROM tasks WHERE id = ?').run(t3.id);
    expect(engine.createLocalTask(input).key).toBe('LOC-0004');
  });

  it('gives distinct consecutive keys for simultaneous creations', async () => {
    const { engine } = makeEngine();
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => engine.createLocalTask(input)),
      Promise.resolve().then(() => engine.createLocalTask(input)),
    ]);
    expect([a.key, b.key].sort()).toEqual(['LOC-0001', 'LOC-0002']);
  });

  it('gives distinct keys from two engines on one database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiraffe-two-'));
    try {
      const a = makeEngine({}, dir);
      const b = makeEngine({}, dir);
      const keys = [a.engine.createLocalTask(input).key, b.engine.createLocalTask(input).key, a.engine.createLocalTask(input).key];
      expect(keys).toEqual(['LOC-0001', 'LOC-0002', 'LOC-0003']);
    } finally {
      disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps numbering across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiraffe-restart-'));
    try {
      const a = makeEngine({}, dir);
      a.engine.createLocalTask(input);
      a.dispose();
      const b = makeEngine({}, dir);
      expect(b.engine.createLocalTask(input).key).toBe('LOC-0002');
    } finally {
      disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the counter, tasks and journal unchanged when creation rolls back', () => {
    const { engine, raw } = makeEngine();
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => engine.createLocalTask(input)).toThrow(/injected/);
    raw.exec('DROP TRIGGER fail_journal');
    expect(engine.getSetting('local_task_counter')).toBe(0);
    expect(counts(raw)).toEqual({ tasks: 0, journal: 0 });
    expect(engine.createLocalTask(input).key).toBe('LOC-0001');
  });
});

describe('validation (AC-49)', () => {
  it.each([
    [{ ...input, title: '' }, 'title'],
    [{ ...input, title: '   ' }, 'title'],
    [{ ...input, repoPath: '' }, 'repoPath'],
    [{ ...input, repoPath: '  ' }, 'repoPath'],
  ])('rejects %j naming the field and writes nothing', (bad, field) => {
    const { engine, raw } = makeEngine();
    const err = (() => {
      try {
        engine.createLocalTask(bad);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
    expect(counts(raw)).toEqual({ tasks: 0, journal: 0 });
    expect(engine.getSetting('local_task_counter')).toBe(0);
  });
});

describe('setRepository', () => {
  it('updates repo_path only', () => {
    const { engine } = makeEngine();
    const t = engine.createLocalTask(input);
    engine.setRepository(t.id, ' /repos/b ');
    expect(engine.getTask(t.id)).toMatchObject({ repoPath: '/repos/b', status: 'new' });
  });

  it('rejects an empty path and unknown tasks', () => {
    const { engine } = makeEngine();
    const t = engine.createLocalTask(input);
    expect(() => engine.setRepository(t.id, ' ')).toThrow(ValidationError);
    expect(() => engine.setRepository(999, '/x')).toThrow(/not found/i);
  });
});
