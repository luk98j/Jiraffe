import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeRunner } from '@jiraffe/adapters/testing';
import { FakeJiraClient } from '@jiraffe/jira/testing';
import {
  BASE_URL,
  disposeAll,
  eventRows,
  makeEngine,
  newTaskIn,
  runRows,
  say,
  statusOf,
  useRepo,
} from './helpers.ts';

afterEach(() => {
  disposeAll();
  vi.restoreAllMocks();
});

const openRun = (h: ReturnType<typeof makeEngine>, taskId: number, kind: string, pid = 99999) =>
  h.raw
    .prepare(
      "INSERT INTO runs (task_id, kind, status, pid, started_at) VALUES (?, ?, 'running', ?, 'x')",
    )
    .run(taskId, kind, pid);

describe('run recovery (AC-71)', () => {
  it('marks open runs crashed, clears the pid, and signals nobody', async () => {
    const kill = vi.spyOn(process, 'kill');
    const h = makeEngine({ runners: { copilot: new FakeRunner({}) } });
    const a = newTaskIn(h.engine, 'analysing');
    const x = newTaskIn(h.engine, 'running');
    openRun(h, a, 'analysis');
    openRun(h, x, 'execution', 12345);
    h.raw
      .prepare(
        "INSERT INTO runs (task_id, kind, end_reason, finished_at, status) VALUES (?, 'analysis', 'completed', 'earlier', 'finished')",
      )
      .run(a);
    await h.engine.start();
    const runs = runRows(h);
    expect(runs.slice(0, 2).map((r) => [r.end_reason, r.status, r.pid])).toEqual([
      ['crashed', 'finished', null],
      ['crashed', 'finished', null],
    ]);
    expect(runs.slice(0, 2).every((r) => r.finished_at !== null)).toBe(true);
    expect(runs[2]).toMatchObject({ end_reason: 'completed', finished_at: 'earlier' });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('task recovery (AC-72, AC-73, AC-75)', () => {
  it('moves analysing to queued_analysis and running to delegated, one event and one journal row each', async () => {
    const h = makeEngine({ runners: { copilot: new FakeRunner({}) } });
    const a = newTaskIn(h.engine, 'analysing');
    const x = newTaskIn(h.engine, 'running');
    const other = newTaskIn(h.engine, 'waiting_user');
    const journalBefore = h.engine.listJournal({ action: 'status_changed', limit: 1000 }).length;
    await h.engine.start();
    expect(statusOf(h, a)).toBe('queued_analysis');
    expect(statusOf(h, other)).toBe('waiting_user');
    // The recovered execution is claimed at once (here it fails: the repository does not exist).
    expect(statusOf(h, x)).not.toBe('running');
    expect(eventRows(h, 'recovered_to_queued_analysis', a)).toHaveLength(1);
    expect(eventRows(h, 'recovered_to_delegated', x)).toHaveLength(1);
    expect(JSON.parse(eventRows(h, 'recovered_to_delegated', x)[0]!.payload_json!)).toEqual({
      from: 'running',
      to: 'delegated',
    });
    await h.engine.idle();
    const rows = h.engine
      .listJournal({ action: 'status_changed', limit: 1000 })
      .filter((r) => r.detail?.endsWith('(recovery)'));
    expect(rows.map((r) => r.detail).sort()).toEqual([
      'analysing to queued_analysis (recovery)',
      'running to delegated (recovery)',
    ]);
    expect(journalBefore).toBeGreaterThan(0);
  });

  it('skips deleted tasks and starts no agent with auto_analysis off (AC-75)', async () => {
    const fake = new FakeRunner(say());
    const h = makeEngine({ runners: { copilot: fake } });
    const a = newTaskIn(h.engine, 'analysing');
    const gone = newTaskIn(h.engine, 'analysing');
    h.engine.deleteTask(gone);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, a)).toBe('queued_analysis');
    expect(statusOf(h, gone)).toBe('analysing');
    expect(fake.calls).toEqual([]);
    expect(runRows(h)).toEqual([]);
  });

  it('with auto_analysis on, a recovered task is analysed again; a recovered running task restarts in its worktree', async () => {
    const fake = new FakeRunner((c) => (c.prompt.includes('read-only') ? say() : {}));
    const h = makeEngine({ runners: { copilot: fake }, git: realGit });
    const repo = useRepo(h);
    h.engine.updateSetting('auto_analysis', true);
    const a = newTaskIn(h.engine, 'analysing', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, a)).toBe('ready_to_delegate');
  });

  it('a second engine on the same database recovers a killed execution and warns about the restart (AC-72)', async () => {
    const first = makeEngine({
      runners: { copilot: new FakeRunner({ hang: true }) },
      git: realGit,
    });
    const repo = useRepo(first);
    const x = newTaskIn(first.engine, 'delegated', 'analysing', repo.path);
    await first.engine.start();
    await vi.waitFor(() => expect(statusOf(first, x)).toBe('running'));
    first.engine.ctx.workers.close(); // the "crash": the run row stays open, the task stays running
    await first.engine.idle();
    expect(runRows(first)[0]?.finished_at).toBeNull();

    const second = makeEngine(
      { runners: { copilot: new FakeRunner({ hang: true }) }, git: realGit },
      dirname(first.path),
    );
    await second.engine.start();
    expect(runRows(second)[0]).toMatchObject({ end_reason: 'crashed' });
    expect(eventRows(second, 'recovered_to_delegated', x)).toHaveLength(1);
    await vi.waitFor(() => expect(runRows(second)).toHaveLength(2)); // a fresh run in the same worktree
    expect(second.engine.getTaskDetail(x)).toMatchObject({
      hasWorktree: true,
      restartsInWorktree: true,
    });
    second.engine.ctx.workers.close();
    await second.engine.idle();
  });
});

describe('event replay (AC-74)', () => {
  it('marks missed events processed once, and a replayed effect is a no-op', async () => {
    const fake = new FakeRunner(say({ verdict: 'NEEDS_INFO', questions: ['q'] }));
    const h = makeEngine({ runners: { copilot: fake } });
    h.engine.updateSetting('auto_analysis', true);
    const id = h.engine.createLocalTask({ title: 'T', description: '', repoPath: '/r' }).id;
    h.engine.transition(id, 'enqueue'); // not ready yet: the event stays unprocessed
    h.raw
      .prepare("INSERT INTO events (task_id, type, created_at) VALUES (?, 'enqueue', 'x')")
      .run(id); // a duplicate of the same event
    expect(eventRows(h, 'enqueue', id).every((e) => e.processed_at === null)).toBe(true);
    await h.engine.start();
    await h.engine.idle();
    expect(eventRows(h, 'enqueue', id).every((e) => e.processed_at !== null)).toBe(true);
    expect(runRows(h, id)).toHaveLength(1); // two enqueue events, one run
    expect(fake.calls).toHaveLength(1);
    const before = eventRows(h, 'enqueue', id).map((e) => e.processed_at);
    await h.engine.start();
    expect(eventRows(h, 'enqueue', id).map((e) => e.processed_at)).toEqual(before);
  });
});

describe('boot order and isolation (AC-76)', () => {
  it('recovers and starts workers even when sync and retention both fail', async () => {
    const errors: string[] = [];
    const jira = new FakeJiraClient();
    jira.searchPage = async () => {
      throw new Error('jira is down');
    };
    const fake = new FakeRunner(say({ verdict: 'NEEDS_INFO', questions: ['q'] }));
    const h = makeEngine({
      runners: { copilot: fake },
      jiraClient: jira,
      logger: { info() {}, error: (m) => errors.push(m) },
    });
    h.engine.updateSetting('jira_base_url', BASE_URL);
    h.engine.updateSetting('auto_analysis', true);
    const a = newTaskIn(h.engine, 'analysing');
    openRun(h, a, 'analysis');
    // A purge candidate whose deletion fails: retention throws at boot.
    const old = Number(
      h.raw
        .prepare(
          "INSERT INTO tasks (source, local_key, title, status, deleted_at, created_at, updated_at) VALUES ('local','LOC-0900','old','new','2000-01-01T00:00:00.000Z','x','x')",
        )
        .run().lastInsertRowid,
    );
    h.raw
      .prepare(
        "INSERT INTO messages (task_id, role, source, content, created_at) VALUES (?, 'user', 'app', 'm', 'x')",
      )
      .run(old);
    h.raw.exec(
      "CREATE TRIGGER boom BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    await h.engine.start();
    await h.engine.idle();
    expect(runRows(h)[0]).toMatchObject({ end_reason: 'crashed' });
    expect(fake.calls).toHaveLength(1); // recovered, then analysed again after the boot sequence
    expect(statusOf(h, a)).toBe('waiting_user');
    expect(errors.some((m) => m.includes('sync'))).toBe(true);
    expect(errors.some((m) => m.includes('retention'))).toBe(true);
  });
});
