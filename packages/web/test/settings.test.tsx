import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_KEYS } from '@jiraffe/core';
import { renderApp, type Req } from './helpers.tsx';

const defaults = () => Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default]));
function server(
  extra: (req: Req) => ReturnType<import('./helpers.tsx').Handler> = () => undefined,
  sync: object = {
    state: 'idle',
    lastRunAt: null,
    lastError: null,
    lastSkippedAt: null,
    lastResult: null,
  },
) {
  const values: Record<string, unknown> = defaults();
  return (req: Req) => {
    const r = extra(req);
    if (r) return r;
    if (req.method === 'GET' && req.path === '/api/settings')
      return { body: { values, readOnly: ['local_task_counter'], problems: [] } };
    if (req.method === 'PUT' && req.path.startsWith('/api/settings/')) {
      values[req.path.split('/').pop()!] = req.body.value;
      return { body: { values, readOnly: ['local_task_counter'], problems: [] } };
    }
    if (req.path === '/api/sync') return { body: sync };
    return undefined;
  };
}

const SECTION_KEYS: Record<string, string[]> = {
  'Jira connection': [
    'jira_base_url',
    'jira_projects',
    'jira_ignored_statuses',
    'jira_tasks_sync_minutes',
    'jira_comments_sync_minutes',
  ],
  Agent: [
    'agent',
    'auto_analysis',
    'max_parallel_analysis',
    'max_parallel_execution',
    'run_timeout_minutes',
    'execution_prompt_template',
  ],
  'Usage limits': ['default_max_credits', 'quota_retry_minutes', 'quota_error_patterns'],
  'Repositories and execution': ['repo_map', 'worktrees_dir', 'allowed_tools'],
  'Data retention': ['retention_days', 'journal_retention_days', 'local_task_counter'],
};
const TITLES = Object.keys(SECTION_KEYS);
const section = (title: string) => within(screen.getByRole('region', { name: title }));
const puts = (calls: Req[]) => calls.filter((c) => c.method === 'PUT');
const rejectKey = (key: string) => (req: Req) =>
  req.method === 'PUT' && req.path.endsWith(`/${key}`)
    ? { status: 400, body: { error: { code: 'validation', message: 'Too small', field: key } } }
    : undefined;
const type = async (user: UserEvent, el: HTMLElement, text: string) => {
  await user.clear(el);
  await user.type(el, text);
};

describe('Settings sections (AC-22, AC-23, AC-24)', () => {
  it('shows every setting key once, inside its own section, labelled with the key', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('max_parallel_analysis');
    expect(Object.values(SECTION_KEYS).flat().sort()).toEqual([...SETTING_KEYS].sort());
    for (const k of SETTING_KEYS) expect(screen.getAllByLabelText(k), k).toHaveLength(1);
    for (const [title, keys] of Object.entries(SECTION_KEYS)) {
      for (const k of keys)
        expect(section(title).getByLabelText(k), `${k} in ${title}`).toBeVisible();
      for (const other of TITLES.filter((t) => t !== title))
        for (const k of keys)
          expect(section(other).queryByLabelText(k), `${k} not in ${other}`).toBeNull();
    }
    expect(screen.getByLabelText('auto_analysis')).not.toBeChecked();
    expect(screen.getByLabelText('retention_days')).toHaveValue(28);
    expect(screen.getByLabelText('allowed_tools')).toHaveValue(
      JSON.stringify(SETTINGS.allowed_tools.default, null, 2),
    );
  });

  it('shows the five section headings in order', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('max_parallel_analysis');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(TITLES);
  });

  it('has one Save button per section and no per-key Save button', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('max_parallel_analysis');
    const saves = screen.getAllByRole('button', { name: /^Save/ }).map((b) => b.textContent);
    expect(saves).toEqual(TITLES.map((t) => `Save ${t}`));
    for (const k of SETTING_KEYS)
      expect(screen.queryByRole('button', { name: `Save ${k}` }), k).toBeNull();
  });

  it('renders local_task_counter read-only inside Data retention, which still has its Save', async () => {
    renderApp('/settings', server());
    const counter = await screen.findByLabelText('local_task_counter');
    expect(counter).toHaveAttribute('readonly');
    expect(
      section('Data retention').getByRole('button', { name: 'Save Data retention' }),
    ).toBeVisible();
  });

  it('shows stored-value problems', async () => {
    renderApp('/settings', (req) =>
      req.path === '/api/settings'
        ? {
            body: {
              values: defaults(),
              readOnly: [],
              problems: [{ key: 'retention_days', message: 'Stored value is invalid' }],
            },
          }
        : undefined,
    );
    expect(await screen.findByText(/Stored value is invalid/)).toBeInTheDocument();
  });
});

describe('Jira credentials help (AC-20, AC-21)', () => {
  const notConfigured = {
    state: 'not_configured',
    lastRunAt: null,
    lastError: null,
    lastSkippedAt: null,
    lastResult: null,
  };

  it.each([
    ['idle', undefined],
    ['not_configured', notConfigured],
  ])('names both variables and the rules in the Jira connection section (%s)', async (_n, sync) => {
    renderApp('/settings', server(undefined, sync));
    await screen.findByLabelText('jira_base_url');
    const jira = section('Jira connection');
    expect(jira.getByText('JIRA_EMAIL', { selector: 'code' })).toBeVisible();
    expect(jira.getByText('JIRA_API_TOKEN', { selector: 'code' })).toBeVisible();
    const help = jira.getByTestId('jira-credentials-help');
    expect(help).toHaveTextContent(/environment/i);
    expect(help).toHaveTextContent(/before .*start/i);
    expect(help).toHaveTextContent(/restart/i);
    expect(help).toHaveTextContent(/not (entered|stored)/i);
    expect(help.querySelector('a')).toBeNull();
  });

  it('offers no input for the e-mail or the token', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('jira_base_url');
    expect(screen.queryByLabelText(/e-?mail|token/i)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /e-?mail|token/i })).toBeNull();
  });
});

describe('Section Save (AC-25 to AC-29)', () => {
  it('sends one PUT per edited key, none for untouched keys, and shows Saved once', async () => {
    const { user, calls } = renderApp('/settings', server());
    await type(user, await screen.findByLabelText('max_parallel_analysis'), '3');
    await type(user, screen.getByLabelText('run_timeout_minutes'), '45');
    await user.click(screen.getByRole('button', { name: 'Save Agent' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls).map((c) => [c.path, c.body])).toEqual([
      ['/api/settings/max_parallel_analysis', { value: 3 }],
      ['/api/settings/run_timeout_minutes', { value: 45 }],
    ]);
    expect(await section('Agent').findByText('Saved')).toBeInTheDocument();
    expect(screen.getAllByText('Saved')).toHaveLength(1);
  });

  it('toggles a boolean and sends null for a cleared optional number', async () => {
    const { user, calls } = renderApp('/settings', server());
    await user.click(await screen.findByLabelText('auto_analysis'));
    await user.click(screen.getByRole('button', { name: 'Save Agent' }));
    await waitFor(() => expect(puts(calls).map((c) => c.body)).toEqual([{ value: true }]));

    await type(user, screen.getByLabelText('journal_retention_days'), '30');
    await user.click(screen.getByRole('button', { name: 'Save Data retention' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    await user.clear(screen.getByLabelText('journal_retention_days'));
    await user.click(screen.getByRole('button', { name: 'Save Data retention' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(3));
    expect(puts(calls)[2]).toMatchObject({
      path: '/api/settings/journal_retention_days',
      body: { value: null },
    });
  });

  it('sends nothing and says so when no field was edited, also after a revert (AC-26)', async () => {
    const { user, calls } = renderApp('/settings', server());
    await screen.findByLabelText('max_parallel_analysis');
    await user.click(screen.getByRole('button', { name: 'Save Agent' }));
    expect(await section('Agent').findByText('No changes to save')).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);

    await type(user, screen.getByLabelText('max_parallel_analysis'), '5');
    await type(user, screen.getByLabelText('max_parallel_analysis'), '2'); // back to the stored value
    await user.click(screen.getByRole('button', { name: 'Save Agent' }));
    expect(await section('Agent').findByText('No changes to save')).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it('sends nothing when a JSON field is invalid, and names the field (AC-27)', async () => {
    const { user, calls } = renderApp('/settings', server());
    const tools = await screen.findByLabelText('allowed_tools');
    await user.clear(tools);
    await user.type(tools, 'not json');
    await type(user, screen.getByLabelText('worktrees_dir'), '/tmp/wt');
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Save Repositories and execution' }));
    expect(await screen.findByText('allowed_tools: Invalid JSON')).toBeInTheDocument();
    expect(calls).toHaveLength(before);
    expect(puts(calls)).toHaveLength(0);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('keeps an accepted key, shows the server message on the rejected field and no Saved (AC-28)', async () => {
    const { user, calls } = renderApp('/settings', server(rejectKey('max_parallel_analysis')));
    await type(user, await screen.findByLabelText('max_parallel_analysis'), '0');
    await type(user, screen.getByLabelText('max_parallel_execution'), '4');
    await user.click(screen.getByRole('button', { name: 'Save Agent' }));
    expect(await screen.findByText('Too small')).toBeInTheDocument();
    expect(puts(calls).map((c) => c.path)).toEqual([
      '/api/settings/max_parallel_analysis',
      '/api/settings/max_parallel_execution',
    ]);
    await waitFor(() => expect(screen.getByLabelText('max_parallel_analysis')).toHaveValue(2));
    expect(screen.getByLabelText('max_parallel_execution')).toHaveValue(4);
    expect(screen.queryByText('Saved')).toBeNull();
    expect(section('Agent').getByText('Too small').closest('.setting-row')).toContainElement(
      screen.getByLabelText('max_parallel_analysis'),
    );
  });

  it('keeps an unsaved edit in another section when a section is saved (AC-29)', async () => {
    const { user, calls } = renderApp('/settings', server());
    await user.click(await screen.findByLabelText('auto_analysis'));
    await type(user, screen.getByLabelText('jira_base_url'), 'https://x.atlassian.net');
    await user.click(screen.getByRole('button', { name: 'Save Jira connection' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toMatchObject({
      path: '/api/settings/jira_base_url',
      body: { value: 'https://x.atlassian.net' },
    });
    await section('Jira connection').findByText('Saved');
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/settings').length).toBeGreaterThan(1),
    );
    expect(screen.getByLabelText('auto_analysis')).toBeChecked();
    expect(puts(calls)).toHaveLength(1);
  });
});

describe('Sync panel', () => {
  it('says Jira is not configured', async () => {
    renderApp(
      '/settings',
      server(undefined, {
        state: 'not_configured',
        lastRunAt: null,
        lastError: null,
        lastSkippedAt: null,
        lastResult: null,
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Jira sync' });
    await waitFor(() =>
      expect(panel).toHaveTextContent(
        'Jira not configured: jira_base_url is empty. Set jira_base_url in this section and click Save Jira connection to start syncing.',
      ),
    );
  });

  it('sits inside the Jira connection section', async () => {
    renderApp('/settings', server());
    await screen.findByLabelText('jira_base_url');
    expect(section('Jira connection').getByRole('region', { name: 'Jira sync' })).toBeVisible();
    expect(screen.getAllByRole('region', { name: 'Jira sync' })).toHaveLength(1);
  });

  it('shows the last result and triggers Sync now', async () => {
    const { user, calls } = renderApp(
      '/settings',
      server(undefined, {
        state: 'idle',
        lastRunAt: '2026-11-21T10:00:00.000Z',
        lastError: null,
        lastSkippedAt: null,
        lastResult: '0 new, 0 updated; Jira returned 0 issues',
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Jira sync' });
    await waitFor(() =>
      expect(panel).toHaveTextContent(
        'State: idle, last run 2026-11-21T10:00:00.000Z (0 new, 0 updated; Jira returned 0 issues)',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/sync')).toBe(true),
    );
  });

  it('shows a sync error message', async () => {
    renderApp(
      '/settings',
      server(undefined, {
        state: 'error',
        lastRunAt: null,
        lastError: 'Jira rejected the credentials (HTTP 401)',
        lastSkippedAt: null,
        lastResult: null,
      }),
    );
    expect(await screen.findByText(/Jira rejected the credentials/)).toBeInTheDocument();
  });
});
