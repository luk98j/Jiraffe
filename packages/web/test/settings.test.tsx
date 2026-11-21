import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_KEYS } from '@jiraffe/core';
import { renderApp, type Req } from './helpers.tsx';

const defaults = () => Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default]));
function server(extra: (req: Req) => ReturnType<import('./helpers.tsx').Handler> = () => undefined, sync: object = { state: 'idle', lastRunAt: null, lastError: null, lastSkippedAt: null, lastResult: null }) {
  const values: Record<string, unknown> = defaults();
  return (req: Req) => {
    const r = extra(req);
    if (r) return r;
    if (req.method === 'GET' && req.path === '/api/settings') return { body: { values, readOnly: ['local_task_counter'], problems: [] } };
    if (req.method === 'PUT' && req.path.startsWith('/api/settings/')) {
      values[req.path.split('/').pop()!] = req.body.value;
      return { body: { values, readOnly: ['local_task_counter'], problems: [] } };
    }
    if (req.path === '/api/sync') return { body: sync };
    return undefined;
  };
}

describe('Settings view (AC-72, AC-85)', () => {
  it('shows one row per setting key', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('max_parallel_analysis');
    for (const k of SETTING_KEYS) expect(screen.getByLabelText(k), k).toBeInTheDocument();
    expect(screen.getByLabelText('auto_analysis')).not.toBeChecked();
    expect(screen.getByLabelText('retention_days')).toHaveValue(28);
    expect(screen.getByLabelText('allowed_tools')).toHaveValue(JSON.stringify(SETTINGS.allowed_tools.default, null, 2));
  });

  it('saves a valid number and shows success', async () => {
    const { user, calls } = renderApp('/settings', server());
    const input = await screen.findByLabelText('max_parallel_analysis');
    await user.clear(input);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Save max_parallel_analysis' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ value: 3 }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows the server message for an invalid value and keeps the old value', async () => {
    const { user } = renderApp('/settings', server((req) =>
      req.method === 'PUT' ? { status: 400, body: { error: { code: 'validation', message: 'Too small', field: 'max_parallel_analysis' } } } : undefined));
    const input = await screen.findByLabelText('max_parallel_analysis');
    await user.clear(input);
    await user.type(input, '0');
    await user.click(screen.getByRole('button', { name: 'Save max_parallel_analysis' }));
    expect(await screen.findByText('Too small')).toBeInTheDocument();
    expect(screen.getByLabelText('max_parallel_analysis')).toHaveValue(2);
  });

  it('toggles a boolean, sends null for an empty optional number and validates JSON locally', async () => {
    const { user, calls } = renderApp('/settings', server());
    await user.click(await screen.findByLabelText('auto_analysis'));
    await user.click(screen.getByRole('button', { name: 'Save auto_analysis' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.path.endsWith('auto_analysis'))?.body).toEqual({ value: true }));

    const jr = screen.getByLabelText('journal_retention_days');
    await user.type(jr, '30');
    await user.clear(jr);
    await user.click(screen.getByRole('button', { name: 'Save journal_retention_days' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('journal_retention_days'))?.body).toEqual({ value: null }));

    const tools = screen.getByLabelText('allowed_tools');
    await user.clear(tools);
    await user.type(tools, 'not json');
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Save allowed_tools' }));
    expect(await screen.findByText('Invalid JSON')).toBeInTheDocument();
    expect(calls).toHaveLength(before);
  });

  it('renders local_task_counter read-only with no save control', async () => {
    renderApp('/settings', server());
    const counter = await screen.findByLabelText('local_task_counter');
    expect(counter).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save local_task_counter' })).toBeNull();
  });

  it('shows stored-value problems', async () => {
    renderApp('/settings', (req) =>
      req.path === '/api/settings' ? { body: { values: defaults(), readOnly: [], problems: [{ key: 'retention_days', message: 'Stored value is invalid' }] } } : undefined);
    expect(await screen.findByText(/Stored value is invalid/)).toBeInTheDocument();
  });
});

describe('Sync panel', () => {
  it('says Jira is not configured', async () => {
    renderApp('/settings', server(undefined, { state: 'not_configured', lastRunAt: null, lastError: null, lastSkippedAt: null, lastResult: null }));
    expect(await screen.findAllByText('Jira not configured')).not.toHaveLength(0);
  });

  it('shows the last result and triggers Sync now', async () => {
    const { user, calls } = renderApp('/settings', server(undefined, { state: 'idle', lastRunAt: '2026-11-21T10:00:00.000Z', lastError: null, lastSkippedAt: null, lastResult: '3 new, 0 updated' }));
    expect(await screen.findByText(/3 new, 0 updated/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/sync')).toBe(true));
  });

  it('shows a sync error message', async () => {
    renderApp('/settings', server(undefined, { state: 'error', lastRunAt: null, lastError: 'Jira rejected the credentials (HTTP 401)', lastSkippedAt: null, lastResult: null }));
    expect(await screen.findByText(/Jira rejected the credentials/)).toBeInTheDocument();
  });
});
