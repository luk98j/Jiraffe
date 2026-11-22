import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageDto, TaskDto } from '@jiraffe/core';
import { renderApp, task } from './helpers.tsx';

const msg = (id: number, over: Partial<MessageDto> = {}): MessageDto => ({
  id,
  taskId: 1,
  role: 'user',
  source: 'app',
  content: `m${id}`,
  createdAt: `2026-11-20T10:0${id}:00.000Z`,
  ...over,
});

function server(initial: { task: TaskDto; messages: MessageDto[] }) {
  const state = { ...initial, messages: [...initial.messages] };
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
