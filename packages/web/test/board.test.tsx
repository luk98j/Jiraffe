import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUSES, type Status } from '@jiraffe/core';
import { renderApp, task, withTasks } from './helpers.tsx';

afterEach(() => vi.restoreAllMocks());

// Section 9 table, written out literally (AC-60, AC-63).
const VIEW: Record<Status, { label: string; color: string; actions: string[] }> = {
  new: { label: 'New / Queued', color: 'grey', actions: ['Analyse', 'Delete'] },
  queued_analysis: { label: 'New / Queued', color: 'grey', actions: ['Analyse', 'Delete'] },
  analysing: { label: 'Analysing', color: 'blue', actions: ['Cancel'] },
  waiting_user: { label: 'Waiting for you', color: 'orange', actions: ['Answer', 'Delete'] },
  ready_to_delegate: {
    label: 'Ready to delegate',
    color: 'green',
    actions: ['Delegate', 'Re-analyse', 'Delete'],
  },
  delegated: { label: 'Queued for execution', color: 'blue', actions: ['Cancel'] },
  running: { label: 'Running', color: 'blue', actions: ['Cancel', 'Logs'] },
  paused_quota: { label: 'Paused (usage limit)', color: 'yellow', actions: ['Cancel', 'Resume'] },
  review: { label: 'Needs review', color: 'purple', actions: ['Accept', 'Show diff'] },
  done: { label: 'Done', color: 'darkgreen', actions: ['Delete'] },
  failed: { label: 'Failed', color: 'red', actions: ['Delete', 'Retry', 'Show error'] },
  cancelled: { label: 'Cancelled', color: 'grey', actions: ['Delete'] },
};

const card = async (key: string) => screen.findByTestId(`card-${key}`);
const board = (tasks: ReturnType<typeof task>[], extra?: Parameters<typeof withTasks>[1]) =>
  renderApp(
    '/',
    withTasks(() => tasks, extra),
  );

describe('card state display (AC-60)', () => {
  it.each(STATUSES)('%s shows label, icon and color class', async (status) => {
    board([task({ id: 1, status })]);
    const c = await card('LOC-0001');
    const v = VIEW[status];
    expect(within(c).getByText(v.label)).toBeInTheDocument();
    expect(within(c).getByTestId('status-icon').textContent).toBeTruthy();
    expect(c.className).toContain(`status-${v.color}`);
  });

  it('uses a distinct icon for every status', async () => {
    board(STATUSES.map((status, i) => task({ id: i + 1, status })));
    const icons = await Promise.all(
      STATUSES.map(
        async (_s, i) =>
          within(await card(`LOC-${String(i + 1).padStart(4, '0')}`)).getByTestId('status-icon')
            .textContent,
      ),
    );
    expect(new Set(icons).size).toBe(STATUSES.length);
  });
});

describe('columns (AC-61)', () => {
  it('follows flow order, merges new and queued, and counts', async () => {
    board([
      task({ id: 1, status: 'new' }),
      task({ id: 2, status: 'queued_analysis' }),
      task({ id: 3, status: 'waiting_user' }),
      task({ id: 4, status: 'waiting_user' }),
      task({ id: 5, status: 'review' }),
      task({ id: 6, status: 'failed' }),
      task({ id: 7, status: 'done' }),
    ]);
    await card('LOC-0001');
    const titles = screen.getAllByTestId('column-title').map((e) => e.textContent);
    expect(titles).toEqual([
      'New / Queued',
      'Analysing',
      'Waiting for you',
      'Ready to delegate',
      'Queued for execution',
      'Running',
      'Paused (usage limit)',
      'Needs review',
      'Failed',
      'Done',
      'Cancelled',
    ]);
    const col = (id: string) => screen.getByTestId(`column-${id}`);
    expect(within(col('new_queued')).getByTestId('column-count')).toHaveTextContent('2');
    expect(within(col('new_queued')).queryByText(/need you/)).toBeNull();
    expect(within(col('waiting_user')).getByTestId('column-count')).toHaveTextContent('2');
    expect(within(col('waiting_user')).getByText('2 need you')).toBeInTheDocument();
    expect(within(col('review')).getByText('1 need you')).toBeInTheDocument();
    expect(within(col('failed')).getByText('1 need you')).toBeInTheDocument();
    expect(within(col('done')).queryByText(/need you/)).toBeNull();
  });

  it('highlights waiting_user, review and failed cards only', async () => {
    board(STATUSES.map((status, i) => task({ id: i + 1, status })));
    for (const [i, status] of STATUSES.entries()) {
      const c = await card(`LOC-${String(i + 1).padStart(4, '0')}`);
      expect(c.classList.contains('card-highlight'), status).toBe(
        ['waiting_user', 'review', 'failed'].includes(status),
      );
    }
  });

  it('shows an empty board and empty columns', async () => {
    board([]);
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getAllByText('No tasks').length).toBe(11);
  });
});

describe('card content and badges (AC-62)', () => {
  it('shows key, title, repository and source badge', async () => {
    board([
      task({
        id: 1,
        key: 'PROJ-7',
        source: 'jira',
        jiraKey: 'PROJ-7',
        localKey: null,
        title: 'Fix it',
        repoPath: '/repos/x',
      }),
      task({ id: 2, repoPath: null }),
    ]);
    const c = await card('PROJ-7');
    expect(within(c).getByText('PROJ-7')).toBeInTheDocument();
    expect(within(c).getByText('Fix it')).toBeInTheDocument();
    expect(within(c).getByText('/repos/x')).toBeInTheDocument();
    expect(within(c).getByText('Jira')).toBeInTheDocument();
    const local = await card('LOC-0002');
    expect(within(local).getByText('Local')).toBeInTheDocument();
    expect(within(local).getByText('No repository')).toBeInTheDocument();
  });

  it('shows each badge exactly when its condition holds', async () => {
    board([
      task({ id: 1, hasNewComment: true }),
      task({ id: 2, bodyChangedAfterAnalysis: true }),
      task({ id: 3, jiraClosed: true }),
      task({ id: 4 }),
    ]);
    const badges = async (n: number) => within(await card(`LOC-000${n}`));
    expect((await badges(1)).getByText('New comment')).toBeInTheDocument();
    expect((await badges(1)).queryByText('Closed in Jira')).toBeNull();
    expect((await badges(2)).getByText('Description changed in Jira')).toBeInTheDocument();
    expect((await badges(3)).getByText('Closed in Jira')).toBeInTheDocument();
    const none = await badges(4);
    for (const t of ['New comment', 'Description changed in Jira', 'Closed in Jira'])
      expect(none.queryByText(t)).toBeNull();
  });
});

describe('card actions (AC-63, AC-64, AC-65)', () => {
  it.each(STATUSES)('%s offers exactly the section 9 actions', async (status) => {
    board([task({ id: 1, status })]);
    const c = await card('LOC-0001');
    const names = [...within(c).queryAllByRole('button'), ...within(c).queryAllByRole('link')]
      .map((e) => e.textContent?.trim() ?? '')
      .filter((t) => t !== 'LOC-0001');
    expect(names.sort()).toEqual([...VIEW[status].actions].sort());
  });

  it.each([
    ['new', 'Analyse', 'enqueue'],
    ['analysing', 'Cancel', 'cancel'],
    ['ready_to_delegate', 'Re-analyse', 'reanalyse'],
    ['failed', 'Retry', 'retry'],
    ['paused_quota', 'Resume', 'resume'],
    ['review', 'Accept', 'review_accepted'],
  ] as const)('%s + %s sends the %s event', async (status, label, event) => {
    const { user, calls } = board([task({ id: 1, status })], (req) =>
      req.method === 'POST' ? { body: { task: task({ id: 1 }) } } : undefined,
    );
    await user.click(within(await card('LOC-0001')).getByRole('button', { name: label }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path === '/api/tasks/1/events' && c.body.event === event,
        ),
      ).toBe(true),
    );
  });

  it('disables Analyse without a repository and on queued tasks, with reasons', async () => {
    board([
      task({ id: 1, repoPath: null }),
      task({ id: 2, status: 'queued_analysis' }),
      task({ id: 3 }),
    ]);
    const a = within(await card('LOC-0001')).getByRole('button', { name: 'Analyse' });
    expect(a).toBeDisabled();
    expect(a).toHaveAttribute('title', 'Choose a repository first');
    const q = within(await card('LOC-0002')).getByRole('button', { name: 'Analyse' });
    expect(q).toBeDisabled();
    expect(q).toHaveAttribute('title', 'Already queued for analysis');
    expect(within(await card('LOC-0003')).getByRole('button', { name: 'Analyse' })).toBeEnabled();
  });

  it('shows Delegate only on ready tasks, always disabled, with the right reason', async () => {
    board([
      task({ id: 1, status: 'ready_to_delegate' }),
      task({ id: 2, status: 'ready_to_delegate', bodyChangedAfterAnalysis: true }),
      task({ id: 3 }),
    ]);
    const d1 = within(await card('LOC-0001')).getByRole('button', { name: 'Delegate' });
    expect(d1).toBeDisabled();
    expect(d1).toHaveAttribute('title', 'Execution is not available yet');
    const d2 = within(await card('LOC-0002')).getByRole('button', { name: 'Delegate' });
    expect(d2).toBeDisabled();
    expect(d2).toHaveAttribute('title', 'Description changed in Jira: re-run the analysis first');
    expect(within(await card('LOC-0003')).queryByRole('button', { name: 'Delegate' })).toBeNull();
  });

  it('Answer, Show diff, Logs and Show error link to the task detail', async () => {
    board([
      task({ id: 1, status: 'waiting_user' }),
      task({ id: 2, status: 'review' }),
      task({ id: 3, status: 'running' }),
      task({ id: 4, status: 'failed' }),
    ]);
    const href = async (n: number, name: string) =>
      within(await card(`LOC-000${n}`))
        .getByRole('link', { name })
        .getAttribute('href');
    expect(await href(1, 'Answer')).toBe('/tasks/1?focus=chat');
    expect(await href(2, 'Show diff')).toBe('/tasks/2');
    expect(await href(3, 'Logs')).toBe('/tasks/3');
    expect(await href(4, 'Show error')).toBe('/tasks/4');
  });

  it('asks for confirmation before deleting and never mentions worktrees', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { user, calls } = board([task({ id: 1 })], (req) =>
      req.method === 'DELETE' ? { status: 204 } : undefined,
    );
    const del = within(await card('LOC-0001')).getByRole('button', { name: 'Delete' });
    await user.click(del);
    expect(confirm).toHaveBeenCalledWith(
      'Delete this task from the local board? Nothing changes in Jira.',
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(del);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/tasks/1')).toBe(true),
    );
  });

  it('keeps card buttons reachable and usable with the keyboard', async () => {
    const { user, calls } = board([task({ id: 1 })], (req) =>
      req.method === 'POST' ? { body: {} } : undefined,
    );
    const analyse = within(await card('LOC-0001')).getByRole('button', { name: 'Analyse' });
    analyse.focus();
    expect(analyse).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.body.event === 'enqueue')).toBe(true),
    );
  });
});

describe('add task and filter (AC-66)', () => {
  it('creates a local task that appears in New / Queued without a reload', async () => {
    const list: ReturnType<typeof task>[] = [];
    const { user, calls } = renderApp(
      '/',
      withTasks(
        () => list,
        (req) => {
          if (req.method === 'POST' && req.path === '/api/tasks') {
            const t = task({ id: 9, title: req.body.title, repoPath: req.body.repoPath });
            list.push(t);
            return { status: 201, body: { task: t } };
          }
        },
      ),
    );
    await screen.findByText('No tasks yet');
    await user.type(screen.getByLabelText('Title'), 'Brand new');
    await user.type(screen.getByLabelText('Description'), 'Some text');
    await user.type(screen.getByLabelText('Repository'), '/repos/z');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    const c = await card('LOC-0009');
    expect(within(screen.getByTestId('column-new_queued')).getByTestId('card-LOC-0009')).toBe(c);
    expect(calls.find((x) => x.method === 'POST')!.body).toEqual({
      title: 'Brand new',
      description: 'Some text',
      repoPath: '/repos/z',
    });
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('shows the server message when the form is rejected', async () => {
    const { user } = renderApp(
      '/',
      withTasks(
        () => [],
        (req) =>
          req.method === 'POST'
            ? {
                status: 400,
                body: {
                  error: { code: 'validation', message: 'Title is required', field: 'title' },
                },
              }
            : undefined,
      ),
    );
    await screen.findByText('No tasks yet');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required');
  });

  it('hides and shows done and cancelled tasks', async () => {
    const { user } = board([
      task({ id: 1, status: 'done' }),
      task({ id: 2, status: 'cancelled' }),
      task({ id: 3 }),
    ]);
    await card('LOC-0001');
    await user.click(screen.getByLabelText('Hide done and cancelled'));
    expect(screen.queryByTestId('card-LOC-0001')).toBeNull();
    expect(screen.queryByTestId('card-LOC-0002')).toBeNull();
    expect(screen.getByTestId('card-LOC-0003')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Hide done and cancelled'));
    expect(screen.getByTestId('card-LOC-0001')).toBeInTheDocument();
  });
});

describe('robustness (AC-73)', () => {
  it('renders 500 tasks', async () => {
    board(Array.from({ length: 500 }, (_, i) => task({ id: i + 1 })));
    await card('LOC-0500');
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(500);
  });

  it('keeps the last data and shows a readable error when a refetch fails', async () => {
    let fail = false;
    const { queryClient } = renderApp('/', (req) => {
      if (req.path !== '/api/tasks') return undefined;
      return fail
        ? { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } }
        : { body: { tasks: [task({ id: 1 })] } };
    });
    await card('LOC-0001');
    fail = true;
    await queryClient.invalidateQueries();
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    expect(screen.getByTestId('card-LOC-0001')).toBeInTheDocument();
  });

  it('explains a network failure in plain English', async () => {
    const { queryClient } = renderApp(
      '/',
      withTasks(() => [task({ id: 1 })]),
    );
    await card('LOC-0001');
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await queryClient.invalidateQueries();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot reach the Jiraffe server. Showing the last loaded data.',
    );
    expect(screen.getByTestId('card-LOC-0001')).toBeInTheDocument();
  });
});
