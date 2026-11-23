import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisDto, MessageDto, TaskDto } from '@jiraffe/core';
import { renderApp, task } from './helpers.tsx';

const msg = (id: number, over: Partial<MessageDto> = {}): MessageDto => ({
  id,
  taskId: 1,
  role: 'user',
  source: 'app',
  content: `m${id}`,
  createdAt: `2026-11-20T10:0${id}:00.000Z`,
  waitsForNextRun: false,
  ...over,
});

const EXTRAS = {
  delegate: { ok: false, reason: 'not ready' as string | null, permissions: [] as string[] },
  lastError: null as { message: string; tail: string | null } | null,
  restartsInWorktree: false,
  hasWorktree: false,
};

function server(
  initial: { task: TaskDto; messages: MessageDto[]; analysis?: AnalysisDto } & Partial<
    typeof EXTRAS
  >,
) {
  const state = {
    analysis: { runs: [] } as AnalysisDto,
    ...EXTRAS,
    ...initial,
    messages: [...initial.messages],
  };
  const handler = (req: import('./helpers.tsx').Req) => {
    if (req.method === 'GET' && req.path === `/api/tasks/${state.task.id}`) return { body: state };
    if (req.method === 'POST' && req.path.endsWith('/messages')) {
      state.messages.push(msg(state.messages.length + 1, { content: req.body.content.trim() }));
      if (state.task.status === 'waiting_user')
        state.task = { ...state.task, status: 'queued_analysis' };
      return { status: 201, body: state };
    }
    if (req.method === 'PATCH') {
      state.task = { ...state.task, repoPath: req.body.repoPath };
      return { body: { task: state.task } };
    }
    return undefined;
  };
  return { state, handler };
}

describe('task detail (AC-67)', () => {
  it('shows fields, a time-ordered chat with markers, and the labelled empty areas', async () => {
    const { handler } = server({
      task: task({
        id: 1,
        key: 'PROJ-1',
        source: 'jira',
        jiraKey: 'PROJ-1',
        localKey: null,
        title: 'Fix it',
        body: 'Long body',
        repoPath: '/repos/x',
        status: 'waiting_user',
      }),
      messages: [
        msg(2, {
          role: 'agent',
          source: 'app',
          content: 'second',
          createdAt: '2026-11-20T10:02:00.000Z',
        }),
        msg(1, {
          role: 'user',
          source: 'jira',
          content: 'first',
          createdAt: '2026-11-20T10:01:00.000Z',
        }),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
    renderApp('/tasks/1', handler);
    expect(await screen.findByRole('heading', { name: /Fix it/ })).toBeInTheDocument();
    expect(screen.getByText('PROJ-1')).toBeInTheDocument();
    expect(screen.getByText('Long body')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
    expect(screen.getByLabelText('Repository')).toHaveValue('/repos/x');
    const items = screen.getAllByTestId('message');
    expect(items.map((i) => within(i).getByTestId('message-text').textContent)).toEqual([
      'first',
      'second',
    ]);
    expect(within(items[0]!).getByText('Jira')).toBeInTheDocument();
    expect(within(items[0]!).getByText('You')).toBeInTheDocument();
    expect(within(items[1]!).getByText('App')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Agent')).toBeInTheDocument();
    for (const area of ['Analysis result', 'Logs', 'Diff']) {
      const region = screen.getByRole('region', { name: area });
      expect(within(region).getByText('Nothing here yet')).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('shows a readable error for an unknown task', async () => {
    renderApp('/tasks/99', () => undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
  });

  it('saves a new repository', async () => {
    const { handler } = server({ task: task({ id: 1, repoPath: null }), messages: [] });
    const { user, calls } = renderApp('/tasks/1', handler);
    const input = await screen.findByLabelText('Repository');
    await user.type(input, '/repos/new');
    await user.click(screen.getByRole('button', { name: 'Save repository' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ repoPath: '/repos/new' }),
    );
  });

  it('focuses the message input when opened with ?focus=chat and fires no event by itself', async () => {
    const { handler } = server({ task: task({ id: 1, status: 'waiting_user' }), messages: [] });
    const { calls } = renderApp('/tasks/1?focus=chat', handler);
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveFocus());
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('chat (AC-68)', () => {
  it('shows a sent message at once, trimmed, and the waiting task moves to New / Queued', async () => {
    const { handler } = server({ task: task({ id: 1, status: 'waiting_user' }), messages: [] });
    const { user, calls } = renderApp('/tasks/1', handler);
    const box = await screen.findByLabelText('Message');
    await user.type(box, '  my answer  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('my answer')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ content: 'my answer' });
    expect(box).toHaveValue('');
    expect(await screen.findByText('New / Queued')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for you')).toBeNull();
  });

  it('does not send empty or whitespace-only messages', async () => {
    const { handler } = server({ task: task({ id: 1 }), messages: [] });
    const { user, calls } = renderApp('/tasks/1', handler);
    const send = await screen.findByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), '   ');
    expect(send).toBeDisabled();
    await user.click(send);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('removes the optimistic message and shows the error when sending fails', async () => {
    const { handler } = server({ task: task({ id: 1 }), messages: [] });
    const { user } = renderApp('/tasks/1', (req) =>
      req.method === 'POST'
        ? { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } }
        : handler(req),
    );
    await user.type(await screen.findByLabelText('Message'), 'will fail');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    await waitFor(() => expect(screen.queryByText('will fail')).toBeNull());
  });
});

describe('analysis result and waiting messages (step 5)', () => {
  const run = (over: Partial<AnalysisDto['runs'][number]>): AnalysisDto['runs'][number] => ({
    runId: 1,
    role: 'analyst',
    agent: 'copilot',
    endReason: 'completed',
    finishedAt: '2026-11-20T10:05:00.000Z',
    answer: null,
    verdict: null,
    ...over,
  });

  it('shows per-agent verdict with icon and text, summary, questions and permissions', async () => {
    const { handler } = server({
      task: task({ id: 1, status: 'waiting_user' }),
      messages: [],
      analysis: {
        runs: [
          run({
            verdict: {
              verdict: 'NEEDS_INFO',
              questions: ['Which API?'],
              missing: ['Acceptance criteria'],
              permissions: ['read: src/**'],
              summary: 'Needs a decision',
            },
          }),
          run({
            runId: 2,
            role: 'architect',
            verdict: {
              verdict: 'READY',
              questions: [],
              missing: [],
              permissions: [],
              summary: 'Looks fine',
            },
          }),
        ],
      },
    });
    renderApp('/tasks/1', handler);
    const region = await screen.findByRole('region', { name: 'Analysis result' });
    const runs = within(region).getAllByTestId('analysis-run');
    expect(within(runs[0]!).getByText('Business analyst')).toBeInTheDocument();
    expect(within(runs[0]!).getByText('Needs information')).toBeInTheDocument();
    expect(within(runs[0]!).getByText('Needs a decision')).toBeInTheDocument();
    expect(within(runs[0]!).getByText('Which API?')).toBeInTheDocument();
    expect(within(runs[0]!).getByText('Acceptance criteria')).toBeInTheDocument();
    expect(
      within(runs[0]!).getByText('Permissions proposed by the agent (not applied)'),
    ).toBeInTheDocument();
    expect(within(runs[0]!).getByText('read: src/**')).toBeInTheDocument();
    expect(within(runs[1]!).getByText('Architect')).toBeInTheDocument();
    expect(within(runs[1]!).getByText('Ready')).toBeInTheDocument();
    expect(within(region).queryByText('Nothing here yet')).toBeNull();
  });

  it('shows a run without a verdict as running or as no verdict', async () => {
    const { handler } = server({
      task: task({ id: 1, status: 'analysing' }),
      messages: [],
      analysis: {
        runs: [
          run({ runId: 1, finishedAt: null, endReason: null }),
          run({ runId: 2, endReason: 'crashed' }),
        ],
      },
    });
    renderApp('/tasks/1', handler);
    const region = await screen.findByRole('region', { name: 'Analysis result' });
    expect(within(region).getByText('Running')).toBeInTheDocument();
    expect(within(region).getByText('No verdict')).toBeInTheDocument();
  });

  it('tags a message that waits for the next run', async () => {
    const { handler } = server({
      task: task({ id: 1, status: 'analysing' }),
      messages: [msg(1, { waitsForNextRun: true }), msg(2)],
    });
    renderApp('/tasks/1', handler);
    const items = await screen.findAllByTestId('message');
    expect(within(items[0]!).getByText(/Waits for next run/)).toBeInTheDocument();
    expect(within(items[1]!).queryByText(/Waits for next run/)).toBeNull();
  });
});

describe('delegate, logs, diff, errors and delete (step 6)', () => {
  const line = (id: number, text: string, stream: 'stdout' | 'stderr' = 'stdout') => ({
    id,
    runId: 1,
    stream,
    text,
    at: 'x',
  });
  function withApi(
    init: Parameters<typeof server>[0],
    api: (req: import('./helpers.tsx').Req) => ReturnType<import('./helpers.tsx').Handler> = () =>
      undefined,
  ) {
    const { handler } = server(init);
    return (req: import('./helpers.tsx').Req) => api(req) ?? handler(req);
  }

  it('shows permissions and allowed tools, and a disabled Delegate with the reason in text and tooltip (AC-40)', async () => {
    const reason = 'Tool restriction flag is not confirmed (spec section 12 item 1)';
    renderApp(
      '/tasks/1',
      withApi(
        {
          task: task({ id: 1, status: 'ready_to_delegate' }),
          messages: [],
          delegate: { ok: false, reason, permissions: ['read: src/**'] },
        },
        (req) =>
          req.path === '/api/settings'
            ? { body: { values: { allowed_tools: ['git status'] }, readOnly: [], problems: [] } }
            : undefined,
      ),
    );
    const region = await screen.findByRole('region', { name: 'Delegate' });
    expect(within(region).getByText('read: src/**')).toBeInTheDocument();
    expect(await within(region).findByText('git status')).toBeInTheDocument();
    expect(within(region).getByText(`Cannot delegate: ${reason}`)).toBeInTheDocument();
    const button = within(region).getByRole('button', { name: 'Delegate' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
  });

  it('enables Delegate when allowed and posts to the endpoint', async () => {
    const { user, calls } = renderApp(
      '/tasks/1',
      withApi(
        {
          task: task({ id: 1, status: 'ready_to_delegate' }),
          messages: [],
          delegate: { ok: true, reason: null, permissions: [] },
        },
        (req) =>
          req.method === 'POST' && req.path === '/api/tasks/1/delegate' ? { body: {} } : undefined,
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/tasks/1/delegate')).toBe(true));
  });

  it('shows log lines with their stream and the truncation notice, paged by event id', async () => {
    const { calls } = renderApp(
      '/tasks/1',
      withApi({ task: task({ id: 1, status: 'running' }), messages: [] }, (req) =>
        req.path === '/api/tasks/1/logs'
          ? { body: { lines: [line(1, 'hello'), line(2, 'oops', 'stderr')], truncated: true } }
          : undefined,
      ),
    );
    const region = await screen.findByRole('region', { name: 'Logs' });
    expect(await within(region).findByText('[stdout] hello')).toBeInTheDocument();
    expect(within(region).getByText('[stderr] oops')).toBeInTheDocument();
    expect(within(region).getByText(/Log storage stopped at 5 MiB/)).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/logs'))?.query.get('after')).toBe('0');
  });

  it('shows the diff with a truncation note, and Accept sends review_accepted', async () => {
    const { user, calls } = renderApp(
      '/tasks/1',
      withApi({ task: task({ id: 1, status: 'review' }), messages: [] }, (req) => {
        if (req.path === '/api/tasks/1/diff')
          return { body: { diff: '+added line', truncated: true, base: 'abc' } };
        if (req.method === 'POST' && req.path === '/api/tasks/1/events') return { body: {} };
        return undefined;
      }),
    );
    expect(await screen.findByText('+added line')).toBeInTheDocument();
    expect(screen.getByText(/The diff was cut at 1 MiB/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/tasks/1/events')?.body).toEqual({
        event: 'review_accepted',
      }),
    );
  });

  it('shows the error of a failed task and the restart warning', async () => {
    renderApp(
      '/tasks/1',
      withApi({
        task: task({ id: 1, status: 'failed' }),
        messages: [],
        lastError: { message: 'git worktree add failed', tail: 'fatal: bad' },
        restartsInWorktree: true,
      }),
    );
    expect(await screen.findByText('git worktree add failed')).toBeInTheDocument();
    expect(screen.getByText('fatal: bad')).toBeInTheDocument();
    expect(screen.getByText(/Execution restarts in the existing worktree/)).toBeInTheDocument();
  });

  it('offers to remove the worktree on delete only when there is one, default off', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, calls } = renderApp(
      '/tasks/1',
      withApi(
        { task: task({ id: 1, status: 'review' }), messages: [], hasWorktree: true },
        (req) => (req.method === 'DELETE' ? { status: 204 } : undefined),
      ),
    );
    const box = await screen.findByLabelText('Also remove the worktree and branch');
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')?.query.get('removeWorktree')).toBe('1'),
    );
    confirm.mockRestore();
  });

  it('has no delete section for a task without a worktree', async () => {
    renderApp('/tasks/1', withApi({ task: task({ id: 1 }), messages: [] }));
    await screen.findByRole('region', { name: 'Logs' });
    expect(screen.queryByLabelText('Also remove the worktree and branch')).toBeNull();
  });
});
