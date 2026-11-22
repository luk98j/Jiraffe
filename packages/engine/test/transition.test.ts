import { afterEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError, TaskNotFoundError, TaskNotReadyError } from '@jiraffe/core';
import { disposeAll, makeEngine, newTaskIn } from './helpers.ts';

afterEach(disposeAll);

const NOW = '2026-11-21T10:00:00.000Z';
const fresh = () => makeEngine({ clock: () => new Date(NOW) });

describe('one transition (AC-12)', () => {
  it('adds exactly one events row and one status_changed journal row', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'analysing');
    const events0 = h.raw.prepare('SELECT count(*) c FROM events').get() as { c: number };
    const journal0 = h.engine.listJournal({}).length;
    h.engine.transition(id, 'analysis_ready');
    expect(h.raw.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: events0.c + 1 });
    const ev = h.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() as Record<
      string,
      unknown
    >;
    expect(ev).toMatchObject({
      task_id: id,
      type: 'analysis_ready',
      processed_at: null,
      created_at: NOW,
    });
    expect(JSON.parse(ev.payload_json as string)).toEqual({
      from: 'analysing',
      to: 'ready_to_delegate',
    });
    const rows = h.engine.listJournal({});
    expect(rows).toHaveLength(journal0 + 1);
    expect(rows[0]).toMatchObject({
      action: 'status_changed',
      taskKey: 'LOC-0001',
      status: 'ready_to_delegate',
      detail: 'analysing to ready_to_delegate',
      at: NOW,
    });
  });
});

describe('atomicity (AC-13, AC-20)', () => {
  it('rolls everything back when the journal insert fails', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'analysing');
    const snap = () => ({
      task: h.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
      events: h.raw.prepare('SELECT * FROM events').all(),
      journal: h.raw.prepare('SELECT * FROM journal').all(),
    });
    const before = snap();
    h.raw.exec(
      "CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => h.engine.transition(id, 'analysis_ready')).toThrow(/injected/);
    h.raw.exec('DROP TRIGGER fail_journal');
    expect(snap()).toEqual(before);
  });

  it('notifies subscribers after commit with the new status readable, and not on rollback', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'analysing');
    const seen: unknown[] = [];
    let changed = 0;
    h.engine.bus.onEvent((e) =>
      seen.push({ ...e, statusInHandler: h.engine.getTask(e.taskId).status }),
    );
    h.engine.bus.onChanged(() => changed++);

    h.engine.transition(id, 'analysis_ready');
    expect(seen).toEqual([
      {
        taskId: id,
        type: 'analysis_ready',
        from: 'analysing',
        to: 'ready_to_delegate',
        statusInHandler: 'ready_to_delegate',
      },
    ]);
    expect(changed).toBe(1);

    h.raw.exec(
      "CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => h.engine.transition(id, 'delegate')).toThrow();
    h.raw.exec('DROP TRIGGER fail_journal');
    expect(seen).toHaveLength(1);
    expect(changed).toBe(1);
  });

  it('is silent for a no-op', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'queued_analysis');
    const seen: unknown[] = [];
    h.engine.bus.onEvent((e) => seen.push(e));
    h.engine.transition(id, 'enqueue');
    expect(seen).toEqual([]);
  });
});

describe('pause and resume (AC-15, AC-16, AC-17)', () => {
  it.each([
    ['analysing', 'quota'],
    ['running', 'credit_limit'],
    ['running', 'quota'],
  ] as const)('%s + %s stores the previous status, reason and resume time', (from, event) => {
    const h = fresh();
    const id = newTaskIn(h.engine, from);
    h.engine.transition(id, event, {
      pauseReason: 'limit hit',
      resumeAt: '2026-11-22T00:00:00.000Z',
    });
    expect(h.engine.getTask(id)).toMatchObject({
      status: 'paused_quota',
      statusBeforePause: from,
      pauseReason: 'limit hit',
      resumeAt: '2026-11-22T00:00:00.000Z',
    });
  });

  it('pause without options leaves reason and resume time empty', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'analysing');
    h.engine.transition(id, 'quota');
    expect(h.engine.getTask(id)).toMatchObject({ pauseReason: null, resumeAt: null });
  });

  it.each(['analysing', 'running'] as const)(
    'resume goes back to %s and clears all pause fields',
    (from) => {
      const h = fresh();
      const id = newTaskIn(h.engine, 'paused_quota', from);
      h.engine.transition(id, 'quota', { pauseReason: 'x', resumeAt: NOW }); // repeated delivery: no-op keeps data
      h.engine.transition(id, 'resume');
      expect(h.engine.getTask(id)).toMatchObject({
        status: from,
        statusBeforePause: null,
        pauseReason: null,
        resumeAt: null,
      });
    },
  );

  it('resume clears pause_reason and resume_at that were stored', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'running');
    h.engine.transition(id, 'credit_limit', { pauseReason: 'r', resumeAt: NOW });
    h.engine.transition(id, 'resume');
    expect(h.engine.getTask(id)).toMatchObject({
      status: 'running',
      statusBeforePause: null,
      pauseReason: null,
      resumeAt: null,
    });
  });

  it('resume throws outside paused_quota even with a stale status_before_pause, and changes nothing', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'new');
    h.raw.prepare("UPDATE tasks SET status_before_pause = 'running' WHERE id = ?").run(id);
    const before = h.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    expect(() => h.engine.transition(id, 'resume')).toThrow(InvalidTransitionError);
    expect(h.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id)).toEqual(before);
  });
});

describe('guards (AC-21)', () => {
  it('throws for an unknown task and writes nothing', () => {
    const h = fresh();
    expect(() => h.engine.transition(999, 'enqueue')).toThrow(TaskNotFoundError);
    expect(h.raw.prepare('SELECT count(*) c FROM events').get()).toEqual({ c: 0 });
  });

  it('throws for a soft-deleted task and writes nothing', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'new');
    h.raw.prepare("UPDATE tasks SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const journal = h.engine.listJournal({}).length;
    expect(() => h.engine.transition(id, 'enqueue')).toThrow(TaskNotFoundError);
    expect(h.engine.listJournal({})).toHaveLength(journal);
    expect(h.engine.getTask(id).status).toBe('new');
  });

  it('throws for an unknown event name', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'new');
    expect(() => h.engine.transition(id, 'bogus' as never)).toThrow(InvalidTransitionError);
  });

  it('refuses to enqueue without a repository and works after one is set', () => {
    const h = fresh();
    const id = newTaskIn(h.engine, 'new');
    h.raw.prepare('UPDATE tasks SET repo_path = NULL WHERE id = ?').run(id);
    expect(() => h.engine.transition(id, 'enqueue')).toThrow(TaskNotReadyError);
    expect(() => h.engine.transition(id, 'enqueue')).toThrow('Choose a repository first');
    expect(h.engine.getTask(id).status).toBe('new');
    h.engine.setRepository(id, '/repos/a');
    expect(h.engine.transition(id, 'enqueue')).toMatchObject({
      changed: true,
      to: 'queued_analysis',
    });
  });
});

describe('body_changed_after_analysis (A17)', () => {
  it('reanalyse clears the flag, user_answered does not', () => {
    const h = fresh();
    const ready = newTaskIn(h.engine, 'ready_to_delegate');
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(ready);
    h.engine.transition(ready, 'reanalyse');
    expect(h.engine.getTask(ready).bodyChangedAfterAnalysis).toBe(false);

    const waiting = newTaskIn(h.engine, 'waiting_user');
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(waiting);
    h.engine.transition(waiting, 'user_answered');
    expect(h.engine.getTask(waiting).bodyChangedAfterAnalysis).toBe(true);
  });
});
