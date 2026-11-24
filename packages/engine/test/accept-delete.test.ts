import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '@jiraffe/adapters';
import { FakeGit, FakeRunner, gitSync } from '@jiraffe/adapters/testing';
import { ConflictError } from '@jiraffe/core';
import { disposeAll, makeEngine, newTaskIn, statusOf, useRepo } from './helpers.ts';

afterEach(disposeAll);

describe('accept (AC-53)', () => {
  it('moves review to done and runs no git command at all', () => {
    const git = new FakeGit();
    const h = makeEngine({ git });
    const id = newTaskIn(h.engine, 'review');
    h.engine.transition(id, 'review_accepted');
    expect(statusOf(h, id)).toBe('done');
    expect(git.calls).toEqual([]);
  });
});

describe('delete with worktree (AC-55)', () => {
  async function twoFinishedTasks() {
    const h = makeEngine({ runners: { copilot: new FakeRunner({}) }, git: realGit });
    const repo = useRepo(h);
    const a = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    const b = newTaskIn(h.engine, 'delegated', 'analysing', repo.path);
    await h.engine.start();
    await h.engine.idle();
    expect([statusOf(h, a), statusOf(h, b)]).toEqual(['review', 'review']);
    const branches = () => gitSync(repo.path, 'branch', '--list', 'task/*');
    return { h, repo, a, b, branches };
  }

  it("removes only that task's worktree and branch when asked", async () => {
    const { h, repo, a, b, branches } = await twoFinishedTasks();
    h.engine.deleteTask(a);
    expect(await h.engine.removeWorktreeAndBranch(a)).toBeNull();
    expect(existsSync(join(repo.worktrees, 'LOC-0001'))).toBe(false);
    expect(existsSync(join(repo.worktrees, 'LOC-0002'))).toBe(true);
    expect(branches()).not.toContain('task/LOC-0001');
    expect(branches()).toContain('task/LOC-0002');
    expect(h.engine.getTask(b).deletedAt).toBeNull();
  });

  it('removes nothing by default, and restore brings back only the record', async () => {
    const { h, repo, a, branches } = await twoFinishedTasks();
    h.engine.deleteTask(a);
    expect(existsSync(join(repo.worktrees, 'LOC-0001'))).toBe(true);
    expect(branches()).toContain('task/LOC-0001');
    h.engine.restoreTask(a);
    expect(h.engine.getTask(a).deletedAt).toBeNull();
    expect(existsSync(join(repo.worktrees, 'LOC-0001'))).toBe(true);
  });

  it('refuses to remove for a task that is not deleted, and returns an error text on git failure', async () => {
    const { h, repo, a } = await twoFinishedTasks();
    await expect(h.engine.removeWorktreeAndBranch(a)).rejects.toThrow(ConflictError);
    h.engine.deleteTask(a);
    rmSync(join(repo.worktrees, 'LOC-0001', '.git'), { recursive: true, force: true });
    const err = await h.engine.removeWorktreeAndBranch(a);
    expect(err).toEqual(expect.stringContaining('git'));
  });

  it('leaves a worktree and branch alone when Jiraffe did not create them', async () => {
    const { h, repo, a, branches } = await twoFinishedTasks();
    h.raw.prepare('UPDATE runs SET branch_created = 0 WHERE task_id = ?').run(a);
    h.engine.deleteTask(a);
    expect(await h.engine.removeWorktreeAndBranch(a)).toMatch(/not created by Jiraffe/);
    expect(existsSync(join(repo.worktrees, 'LOC-0001'))).toBe(true);
    expect(branches()).toContain('task/LOC-0001');
  });

  it('does not remove the worktree while the run is still stopping', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const { h, repo, a } = await twoFinishedTasks();
      h.engine.deleteTask(a);
      h.engine.ctx.workers.live.set(999, { taskId: a, abort() {} });
      const pending = h.engine.removeWorktreeAndBranch(a);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toMatch(/still stopping/);
      expect(existsSync(join(repo.worktrees, 'LOC-0001'))).toBe(true);
      h.engine.ctx.workers.live.delete(999);
      expect(await h.engine.removeWorktreeAndBranch(a)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing for a task that never had a worktree', async () => {
    const h = makeEngine({ git: new FakeGit() });
    const id = newTaskIn(h.engine, 'new');
    h.engine.deleteTask(id);
    expect(await h.engine.removeWorktreeAndBranch(id)).toBeNull();
  });
});
