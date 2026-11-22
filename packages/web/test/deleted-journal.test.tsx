import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JournalDto } from '@jiraffe/core';
import { renderApp, task } from './helpers.tsx';

describe('Deleted view (AC-70)', () => {
  it('lists deleted tasks and restores one', async () => {
    let list = [task({ id: 1, deletedAt: '2026-11-19T10:00:00.000Z', title: 'Old one' })];
    const { user, calls } = renderApp('/deleted', (req) => {
      if (req.path === '/api/deleted') return { body: { tasks: list } };
      if (req.method === 'POST' && req.path === '/api/tasks/1/restore') {
        list = [];
        return { body: { task: task({ id: 1 }) } };
      }
    });
    const row = await screen.findByTestId('deleted-LOC-0001');
    expect(within(row).getByText('Old one')).toBeInTheDocument();
    expect(within(row).getByText(/2026-11-19/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/tasks/1/restore')).toBe(
        true,
      ),
    );
    expect(await screen.findByText('No deleted tasks')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    renderApp('/deleted', (req) =>
      req.path === '/api/deleted' ? { body: { tasks: [] } } : undefined,
    );
    expect(await screen.findByText('No deleted tasks')).toBeInTheDocument();
  });
});

const entry = (id: number, over: Partial<JournalDto>): JournalDto => ({
  id,
  at: `2026-11-2${id}T10:00:00.000Z`,
  taskKey: 'PROJ-1',
  status: 'new',
  action: 'task_imported',
  detail: null,
  ...over,
});

describe('Journal view (AC-71)', () => {
  const rows = [
    entry(3, { taskKey: null, status: null, action: 'sync_run' }),
    entry(2, { taskKey: 'PROJ-2', status: 'analysing', action: 'status_changed' }),
    entry(1, {}),
  ];

  it('shows date, key, status and action in the order returned, with an empty key cell', async () => {
    renderApp('/journal', (req) =>
      req.path === '/api/journal' ? { body: { entries: rows } } : undefined,
    );
    expect(await screen.findAllByTestId('journal-row')).toHaveLength(3);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Date',
      'Task key',
      'Status',
      'Action',
    ]);
    const cells = screen.getAllByTestId('journal-row').map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    );
    expect(cells[0]).toEqual(['2026-11-23 10:00:00', '', '', 'sync_run']);
    expect(cells[1]).toEqual(['2026-11-22 10:00:00', 'PROJ-2', 'analysing', 'status_changed']);
    expect(cells[2]![3]).toBe('task_imported');
  });

  it('sends the filters as query parameters and shows the empty state', async () => {
    const { user, calls } = renderApp('/journal', (req) => {
      if (req.path !== '/api/journal') return undefined;
      const hit = req.query.get('taskKey') === 'NONE';
      return { body: { entries: hit ? [] : rows } };
    });
    await screen.findAllByTestId('journal-row');
    await user.type(screen.getByLabelText('Task key'), 'NONE');
    await user.type(screen.getByLabelText('Action'), 'status_changed');
    expect(await screen.findByText('No journal entries')).toBeInTheDocument();
    const last = calls.filter((c) => c.path === '/api/journal').at(-1)!;
    expect(last.query.get('taskKey')).toBe('NONE');
    expect(last.query.get('action')).toBe('status_changed');
  });
});
