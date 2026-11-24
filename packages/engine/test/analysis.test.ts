import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeGit, FakeRunner, verdictBlock, type StubScript } from '@jiraffe/adapters/testing';
import {
  deferred,
  disposeAll,
  eventRows,
  makeEngine,
  queuedTask,
  runRows,
  say,
  statusOf,
  type Harness,
} from './helpers.ts';

afterEach(disposeAll);

function setup(script: ConstructorParameters<typeof FakeRunner>[0], opts = {}) {
  const fake = new FakeRunner(script);
  const h = makeEngine({ runners: { copilot: fake }, ...opts });
  h.engine.updateSetting('auto_analysis', true);
  return { fake, h };
}
const analyse = async (h: Harness, title = 'T') => {
  const id = queuedTask(h.engine, title);
  await h.engine.start();
  await h.engine.idle();
  return id;
};
const messages = (h: Harness, id: number) =>
  h.raw.prepare('SELECT role, source, content FROM messages WHERE task_id = ? ORDER BY id').all(id);
const lines = (text: string): StubScript => ({
  lines: text.split('\n').map((t) => ({ stream: 'stdout', text: t })),
});

describe('two agents in order (AC-23, AC-25)', () => {
  it('runs the analyst, then the architect, and ends ready_to_delegate', async () => {
    const { fake, h } = setup(say({ summary: 'fine' }, 'ANALYSIS BODY'));
    const finishedWhenSecondStarts: unknown[] = [];
    fake.onStart = () => finishedWhenSecondStarts.push(runRows(h).map((r) => r.end_reason));
    const id = await analyse(h, 'Invoice');
    expect(statusOf(h, id)).toBe('ready_to_delegate');
    const runs = runRows(h, id);
    expect(runs.map((r) => [r.kind, r.agent, r.end_reason, r.status])).toEqual([
      ['analysis', 'copilot', 'completed', 'finished'],
      ['analysis', 'copilot', 'completed', 'finished'],
    ]);
    expect(runs.map((r) => JSON.parse(r.result_json!).role)).toEqual(['analyst', 'architect']);
    expect(fake.calls[0]!.prompt).toContain('business analyst');
    expect(fake.calls[1]!.prompt).toContain('software architect');
    expect(fake.calls[1]!.prompt).toContain('ANALYSIS BODY'); // prior answer
    expect(finishedWhenSecondStarts).toEqual([[null], ['completed', null]]);
    expect(fake.calls[0]!.cwd).toBe('/repos/a');
  });

  it('builds the architect prompt from the database at its start, including newer messages', async () => {
    let n = 0;
    const gate = deferred();
    const { fake, h } = setup((): StubScript => {
      n++;
      return n === 1 ? { ...say(), until: gate.promise } : say();
    });
    const id = queuedTask(h.engine);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    h.engine.addUserMessage(id, 'LATE NOTE');
    gate.resolve();
    await h.engine.idle();
    expect(fake.calls[0]!.prompt).not.toContain('LATE NOTE');
    expect(fake.calls[1]!.prompt).toContain('LATE NOTE');
  });
});

describe('verdicts (AC-26, AC-27)', () => {
  it('turns the analyst NEEDS_INFO questions into agent messages and skips the architect', async () => {
    const { fake, h } = setup(
      say({ verdict: 'NEEDS_INFO', questions: ['Which API?', 'Who signs off?'] }),
    );
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('waiting_user');
    expect(fake.calls).toHaveLength(1);
    expect(messages(h, id)).toEqual([
      { role: 'agent', source: 'app', content: 'Which API?' },
      { role: 'agent', source: 'app', content: 'Who signs off?' },
    ]);
  });

  it('uses the architect NEEDS_INFO the same way', async () => {
    const { h } = setup((_c, n) =>
      n === 1 ? say() : say({ verdict: 'NEEDS_INFO', questions: ['Scale?'] }),
    );
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('waiting_user');
    expect(messages(h, id)).toEqual([{ role: 'agent', source: 'app', content: 'Scale?' }]);
    expect(runRows(h, id).map((r) => r.end_reason)).toEqual(['completed', 'completed']);
  });

  it('is not READY when a READY verdict still lists questions or missing items', async () => {
    const { h } = setup(say({ verdict: 'READY', questions: ['Still unsure?'], missing: ['AC'] }));
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('waiting_user');
    expect(messages(h, id)).toEqual([
      { role: 'agent', source: 'app', content: 'Still unsure?' },
      { role: 'agent', source: 'app', content: 'Missing: AC' },
    ]);
  });

  it('saves the summary when NEEDS_INFO has neither questions nor missing items', async () => {
    const { h } = setup(say({ verdict: 'NEEDS_INFO', summary: 'Too vague' }));
    const id = await analyse(h);
    expect(messages(h, id)).toEqual([{ role: 'agent', source: 'app', content: 'Too vague' }]);
  });
});

describe('invalid output never becomes READY (AC-28)', () => {
  const bad: [string, string][] = [
    ['no block', 'READY, trust me'],
    ['malformed JSON', '```json\n{"verdict": "READY",\n```'],
    ['unknown verdict', verdictBlock({ verdict: 'APPROVED' as never })],
    ['missing field', '```json\n{"verdict":"READY","questions":[],"missing":[]}\n```'],
    ['wrong type', verdictBlock({ questions: 'none' as never })],
  ];
  it.each(bad)('fails the task on %s', async (_n, text) => {
    const { h } = setup(lines(`prose\n${text}`));
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('failed');
    expect(runRows(h, id)).toHaveLength(1);
    expect(runRows(h, id)[0]).toMatchObject({ end_reason: 'crashed' });
    expect(JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!).message).toBe(
      'Agent returned no valid verdict',
    );
    expect(eventRows(h, 'analysis_ready', id)).toEqual([]);
  });

  it('fails when a valid verdict comes with a non-zero exit', async () => {
    const { h } = setup({ ...say(), exitCode: 1 });
    expect(statusOf(h, await analyse(h))).toBe('failed');
  });
});

describe('permissions, summary and the journal (AC-30, AC-31)', () => {
  const permissions = ['read: src/**', 'run: gradle test'];

  it('stores permissions, shows the summary, and never copies permissions into allowed_tools', async () => {
    const { h } = setup(say({ permissions, summary: 'SUMMARY_MARK' }));
    const before = h.engine.getSetting('allowed_tools');
    const id = await analyse(h);
    const detail = h.engine.getTaskDetail(id);
    expect(detail.analysis.runs.map((r) => r.role)).toEqual(['analyst', 'architect']);
    expect(detail.analysis.runs[0]?.verdict).toMatchObject({
      permissions,
      summary: 'SUMMARY_MARK',
    });
    expect(h.engine.getSetting('allowed_tools')).toEqual(before);
    expect(h.engine.listJournal({ action: 'settings_changed', limit: 100 })).toHaveLength(1); // auto_analysis only
  });

  it('keeps summary, questions and answer text out of the journal', async () => {
    const { h } = setup(
      say(
        { verdict: 'NEEDS_INFO', questions: ['QUESTION_MARK'], summary: 'SUMMARY_MARK' },
        'PROSE_MARK',
      ),
    );
    await analyse(h);
    const journal = h.engine.listJournal({ limit: 1000 });
    expect(
      journal
        .filter((j) => j.action === 'status_changed')
        .map((j) => j.detail)
        .reverse(),
    ).toEqual([
      'new to queued_analysis',
      'queued_analysis to analysing',
      'analysing to waiting_user',
    ]);
    const all = JSON.stringify(journal);
    for (const m of ['QUESTION_MARK', 'SUMMARY_MARK', 'PROSE_MARK']) expect(all).not.toContain(m);
  });
});

describe('body_changed_after_analysis (AC-32a)', () => {
  it('is never cleared by an analysis, a retry or user_answered', async () => {
    let n = 0;
    const { h } = setup((): StubScript => {
      n++;
      if (n === 1) return say({ verdict: 'NEEDS_INFO', questions: ['q'] });
      if (n === 2) return { exitCode: 1 };
      return say();
    });
    const flag = (id: number) =>
      (
        h.raw.prepare('SELECT body_changed_after_analysis f FROM tasks WHERE id = ?').get(id) as {
          f: number;
        }
      ).f;
    const id = queuedTask(h.engine);
    h.raw.prepare('UPDATE tasks SET body_changed_after_analysis = 1 WHERE id = ?').run(id);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('waiting_user');
    expect(flag(id)).toBe(1);

    h.engine.addUserMessage(id, 'answer'); // user_answered -> queued -> analysis 2 crashes
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    expect(flag(id)).toBe(1);

    h.engine.transition(id, 'retry'); // -> queued -> analysis ends ready
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('ready_to_delegate');
    expect(flag(id)).toBe(1);

    h.engine.transition(id, 'reanalyse'); // only this event clears it
    expect(flag(id)).toBe(0);
  });
});

describe('messages during and after a run (AC-33, AC-34)', () => {
  it('keeps the run going, marks the message "waits for next run", and starts no new analysis', async () => {
    let now = Date.parse('2026-11-23T10:00:00.000Z');
    const gate = deferred();
    const { fake, h } = setup({ ...say(), until: gate.promise }, { clock: () => new Date(now) });
    const id = queuedTask(h.engine);
    await h.engine.start();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    now += 5000;
    h.engine.addUserMessage(id, 'one more thing');
    expect(statusOf(h, id)).toBe('analysing');
    expect(h.engine.listMessages(id).map((m) => [m.content, m.waitsForNextRun])).toEqual([
      ['one more thing', true],
    ]);
    expect(runRows(h, id).filter((r) => r.finished_at === null)).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    gate.resolve();
    await h.engine.idle();
  });

  it('re-queues on a user answer and puts the answer into the next prompt', async () => {
    let n = 0;
    const { fake, h } = setup((): StubScript => {
      n++;
      return n === 1 ? say({ verdict: 'NEEDS_INFO', questions: ['Which API?'] }) : say();
    });
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('waiting_user');
    h.engine.addUserMessage(id, 'Use the v2 API');
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('ready_to_delegate');
    const second = fake.calls[1]!.prompt;
    expect(second).toContain('[app] user: Use the v2 API');
    expect(second).toContain('[app] agent: Which API?');
  });
});

describe('read-only guard around analysis', () => {
  const status = (outputs: string[]) =>
    new FakeGit((args, _cwd, n) =>
      args[0] === 'status' ? { stdout: outputs[Math.min(n - 1, outputs.length - 1)] ?? '' } : {},
    );

  it('fails the run when the repository status differs after the analysis', async () => {
    const git = status(['', ' M src/a.ts\n']);
    const { h } = setup(say(), { git });
    const id = await analyse(h);
    expect(statusOf(h, id)).toBe('failed');
    expect(JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!).message).toBe(
      'The analysis changed files in the repository',
    );
    expect(git.calls.map((c) => c.args.join(' '))).toEqual([
      'status --porcelain',
      'status --porcelain',
    ]);
  });

  it('does not mind a repository that was already dirty and did not change', async () => {
    const { h } = setup(say(), { git: status([' M already.ts\n']) });
    expect(statusOf(h, await analyse(h))).toBe('ready_to_delegate');
  });

  it('skips the check when git cannot read the directory', async () => {
    const git = new FakeGit(() => ({ code: 128, stderr: 'not a git repository' }));
    const { h } = setup(say(), { git });
    expect(statusOf(h, await analyse(h))).toBe('ready_to_delegate');
  });
});
