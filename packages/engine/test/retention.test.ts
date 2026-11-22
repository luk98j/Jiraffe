import { afterEach, describe, expect, it } from 'vitest';
import { disposeAll, makeEngine, rawChildren, rawTask } from './helpers.ts';

afterEach(disposeAll);

const NOW = new Date('2026-11-21T12:00:00.000Z');
const daysAgo = (d: number, extraMs = 0) =>
  new Date(NOW.getTime() - d * 86_400_000 - extraMs).toISOString();
const fresh = () => makeEngine({ clock: () => NOW });
const count = (h: ReturnType<typeof makeEngine>, table: string, where = '1=1') =>
  (h.raw.prepare(`SELECT count(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
const exists = (h: ReturnType<typeof makeEngine>, id: number) =>
  count(h, 'tasks', `id = ${id}`) === 1;

describe('purge of deleted tasks (AC-54, AC-57, AC-84)', () => {
  it('purges only the 29-day task with its children, keeps journal rows, journals task_purged', () => {
    const h = fresh();
    const old = rawTask(h.raw, { localKey: 'LOC-0001', status: 'failed', deletedAt: daysAgo(29) });
    const recent = rawTask(h.raw, { localKey: 'LOC-0002', deletedAt: daysAgo(27) });
    rawChildren(h.raw, old, 'LOC-0001');
    rawChildren(h.raw, recent, 'LOC-0002');
    h.engine.runRetention();
    expect(exists(h, old)).toBe(false);
    expect(exists(h, recent)).toBe(true);
    for (const t of ['messages', 'runs', 'events'])
      expect(count(h, t, `task_id = ${old}`), t).toBe(0);
    for (const t of ['messages', 'runs', 'events'])
      expect(count(h, t, `task_id = ${recent}`), t).toBe(1);
    expect(count(h, 'journal', "task_key = 'LOC-0001' AND action = 'task_created'")).toBe(1);
    expect(h.engine.listJournal({ action: 'task_purged' })).toEqual([
      expect.objectContaining({ taskKey: 'LOC-0001', status: 'failed', at: NOW.toISOString() }),
    ]);
    expect(count(h, 'ignored_jira_keys')).toBe(0);
  });

  it('does not purge exactly 28 days, purges 28 days and 1 second (AC-84)', () => {
    const h = fresh();
    const exact = rawTask(h.raw, { localKey: 'LOC-0001', deletedAt: daysAgo(28) });
    const over = rawTask(h.raw, { localKey: 'LOC-0002', deletedAt: daysAgo(28, 1000) });
    h.engine.runRetention();
    expect(exists(h, exact)).toBe(true);
    expect(exists(h, over)).toBe(false);
  });

  it('uses retention_days = 7', () => {
    const h = fresh();
    h.engine.updateSetting('retention_days', 7);
    const a = rawTask(h.raw, { localKey: 'LOC-0001', deletedAt: daysAgo(8) });
    const b = rawTask(h.raw, { localKey: 'LOC-0002', deletedAt: daysAgo(6) });
    h.engine.runRetention();
    expect([exists(h, a), exists(h, b)]).toEqual([false, true]);
  });

  it('keeps a live task with no deleted_at', () => {
    const h = fresh();
    const id = rawTask(h.raw, { localKey: 'LOC-0001' });
    h.engine.runRetention();
    expect(exists(h, id)).toBe(true);
  });

  it('keeps numbering after a purge (AC-47)', () => {
    const h = fresh();
    h.engine.createLocalTask({ title: 'a', description: '', repoPath: '/r' });
    const t2 = h.engine.createLocalTask({ title: 'b', description: '', repoPath: '/r' });
    const t3 = h.engine.createLocalTask({ title: 'c', description: '', repoPath: '/r' });
    h.raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(daysAgo(1), t2.id);
    h.raw.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(daysAgo(40), t3.id);
    h.engine.runRetention();
    expect(exists(h, t3.id)).toBe(false);
    expect(h.engine.createLocalTask({ title: 'd', description: '', repoPath: '/r' }).key).toBe(
      'LOC-0004',
    );
  });
});

describe('purge of closed-in-Jira tasks (AC-55, AC-56, AC-83)', () => {
  it('purges only the 29-day task and tombstones its key', () => {
    const h = fresh();
    const old = rawTask(h.raw, { jiraKey: 'P-1', closedInJiraAt: daysAgo(29) });
    const recent = rawTask(h.raw, { jiraKey: 'P-2', closedInJiraAt: daysAgo(27) });
    h.engine.runRetention();
    expect([exists(h, old), exists(h, recent)]).toEqual([false, true]);
    expect(h.raw.prepare('SELECT * FROM ignored_jira_keys').all()).toEqual([
      { jira_key: 'P-1', deleted_at: NOW.toISOString() },
    ]);
    expect(h.engine.listJournal({ taskKey: 'P-1', action: 'task_purged' })).toHaveLength(1);
  });

  it('writes the tombstone, journal and delete in one transaction', () => {
    const h = fresh();
    const id = rawTask(h.raw, { jiraKey: 'P-1', closedInJiraAt: daysAgo(40) });
    h.raw.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => h.engine.runRetention()).toThrow(/injected/);
    h.raw.exec('DROP TRIGGER fail_delete');
    expect(exists(h, id)).toBe(true);
    expect(count(h, 'ignored_jira_keys')).toBe(0);
    expect(count(h, 'journal', "action = 'task_purged'")).toBe(0);
  });

  it('skips a running closed task, then purges it once it is cancelled', () => {
    const h = fresh();
    const id = rawTask(h.raw, { jiraKey: 'P-1', status: 'running', closedInJiraAt: daysAgo(40) });
    h.engine.runRetention();
    expect(exists(h, id)).toBe(true);
    h.engine.transition(id, 'cancel');
    h.engine.runRetention();
    expect(exists(h, id)).toBe(false);
  });

  it('does not apply the closed rule to local tasks', () => {
    const h = fresh();
    const id = rawTask(h.raw, { localKey: 'LOC-0001', closedInJiraAt: daysAgo(40) });
    h.engine.runRetention();
    expect(exists(h, id)).toBe(true);
  });

  it('purges a task that is both deleted and closed exactly once', () => {
    const h = fresh();
    rawTask(h.raw, { jiraKey: 'P-1', deletedAt: daysAgo(40), closedInJiraAt: daysAgo(40) });
    h.engine.runRetention();
    expect(count(h, 'journal', "action = 'task_purged'")).toBe(1);
    expect(count(h, 'ignored_jira_keys')).toBe(1);
  });
});

describe('journal retention (AC-58)', () => {
  const seed = (h: ReturnType<typeof makeEngine>) => {
    const ins = h.raw.prepare("INSERT INTO journal (at, action) VALUES (?, 'sync_run')");
    ins.run(daysAgo(40));
    ins.run(daysAgo(20));
  };

  it('deletes nothing when journal_retention_days is empty', () => {
    const h = fresh();
    seed(h);
    h.engine.runRetention();
    expect(count(h, 'journal')).toBe(2);
  });

  it('deletes rows older than journal_retention_days', () => {
    const h = fresh();
    h.engine.updateSetting('journal_retention_days', 30);
    const before = count(h, 'journal');
    seed(h);
    h.engine.runRetention();
    expect(count(h, 'journal')).toBe(before + 1);
    expect(count(h, 'journal', `at < '${daysAgo(30)}'`)).toBe(0);
  });
});
