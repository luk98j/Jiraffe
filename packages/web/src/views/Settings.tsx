import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SETTINGS, type SettingKey } from '@jiraffe/core';
import { request } from '../api.ts';
import { useApiMutation, useSettings, useSync } from '../queries.ts';

const toDraft = (key: SettingKey, stored: unknown): string | boolean => {
  const kind = SETTINGS[key].input;
  if (kind === 'boolean') return stored === true;
  if (kind === 'json') return JSON.stringify(stored, null, 2);
  return stored === null || stored === undefined ? '' : String(stored);
};

type Draft = string | boolean;
type Drafts = Partial<Record<SettingKey, Draft>>;
type Message = { ok: boolean; lines: string[] };

/** The five sections shown on the page; every key in SETTING_KEYS appears in exactly one. */
const SECTIONS: { title: string; keys: SettingKey[] }[] = [
  {
    title: 'Jira connection',
    keys: [
      'jira_base_url',
      'jira_projects',
      'jira_ignored_statuses',
      'jira_tasks_sync_minutes',
      'jira_comments_sync_minutes',
    ],
  },
  {
    title: 'Agent',
    keys: [
      'agent',
      'auto_analysis',
      'max_parallel_analysis',
      'max_parallel_execution',
      'run_timeout_minutes',
      'execution_prompt_template',
    ],
  },
  {
    title: 'Usage limits',
    keys: ['default_max_credits', 'quota_retry_minutes', 'quota_error_patterns'],
  },
  { title: 'Repositories and execution', keys: ['repo_map', 'worktrees_dir', 'allowed_tools'] },
  {
    title: 'Data retention',
    keys: ['retention_days', 'journal_retention_days', 'local_task_counter'],
  },
];

function Field({
  name,
  draft,
  readOnly,
  error,
  onChange,
}: {
  name: SettingKey;
  draft: Draft;
  readOnly: boolean;
  error: string | undefined;
  onChange: (value: Draft) => void;
}) {
  const kind = SETTINGS[name].input;
  const id = `setting-${name}`;
  return (
    <div className="setting-row">
      <label htmlFor={id}>{name}</label>
      {kind === 'boolean' && (
        <input
          id={id}
          type="checkbox"
          checked={draft === true}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}
      {kind === 'number' && (
        <input
          id={id}
          type="number"
          value={String(draft)}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {kind === 'text' && (
        <input
          id={id}
          value={String(draft)}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {kind === 'json' && (
        <textarea
          id={id}
          rows={3}
          value={String(draft)}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {readOnly && <small>Read-only</small>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Turns an edited draft into the value sent to the API; throws on invalid JSON. */
function draftValue(key: SettingKey, draft: Draft): unknown {
  const kind = SETTINGS[key].input;
  if (kind === 'boolean') return draft;
  if (kind === 'number') return String(draft).trim() === '' ? null : Number(draft);
  if (kind === 'json') return JSON.parse(String(draft));
  return draft;
}

function Section({
  title,
  keys,
  values,
  readOnlyKeys,
  intro,
}: {
  title: string;
  keys: SettingKey[];
  values: Record<string, unknown>;
  readOnlyKeys: string[];
  intro?: ReactNode;
}) {
  const qc = useQueryClient();
  const isReadOnly = (k: SettingKey) => readOnlyKeys.includes(k) || 'readOnly' in SETTINGS[k];
  const [drafts, setDrafts] = useState<Drafts>(() =>
    Object.fromEntries(keys.map((k) => [k, toDraft(k, values[k])])),
  );
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);

  // A field returns to the stored value only when that key's own stored value changed, so a refetch
  // with the same values never wipes unsaved edits.
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    const changed: Drafts = {};
    for (const k of keys) {
      const now = JSON.stringify(values[k]) ?? 'null';
      if (seen.current[k] !== undefined && seen.current[k] !== now)
        changed[k] = toDraft(k, values[k]);
      seen.current[k] = now;
    }
    if (Object.keys(changed).length > 0) setDrafts((d) => ({ ...d, ...changed }));
  }, [keys, values]);

  const save = async () => {
    setMessage(null);
    setErrors({});
    const edited = keys.filter((k) => !isReadOnly(k) && drafts[k] !== toDraft(k, values[k]));
    if (edited.length === 0) {
      setMessage({ ok: true, lines: ['No changes to save'] });
      return;
    }
    const payload: [SettingKey, unknown][] = [];
    const invalid: string[] = [];
    for (const k of edited) {
      try {
        payload.push([k, draftValue(k, drafts[k] as Draft)]);
      } catch {
        invalid.push(`${k}: Invalid JSON`);
      }
    }
    if (invalid.length > 0) {
      setMessage({ ok: false, lines: invalid });
      return;
    }
    setSaving(true);
    const failed: Partial<Record<SettingKey, string>> = {};
    for (const [k, value] of payload) {
      try {
        await request('PUT', `/api/settings/${k}`, { value });
      } catch (e) {
        failed[k] = (e as Error).message;
      }
    }
    const failedKeys = Object.keys(failed) as SettingKey[];
    if (failedKeys.length > 0) {
      setErrors(failed);
      setDrafts((d) => ({
        ...d,
        ...Object.fromEntries(failedKeys.map((k) => [k, toDraft(k, values[k])])),
      }));
    } else {
      setMessage({ ok: true, lines: ['Saved'] });
    }
    setSaving(false);
    await qc.invalidateQueries();
  };

  const headingId = `section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h3 id={headingId}>{title}</h3>
      {intro}
      {keys.map((k) => (
        <Field
          key={k}
          name={k}
          draft={drafts[k] as Draft}
          readOnly={isReadOnly(k)}
          error={errors[k]}
          onChange={(v) => setDrafts((d) => ({ ...d, [k]: v }))}
        />
      ))}
      <div className="section-actions">
        <button type="button" onClick={save} disabled={saving}>{`Save ${title}`}</button>
        {message?.ok && (
          <span role="status" className="ok">
            {message.lines[0]}
          </span>
        )}
        {message && !message.ok && (
          <div className="error">
            {message.lines.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function SyncPanel() {
  const q = useSync();
  const run = useApiMutation(() => request('POST', '/api/sync'));
  const s = q.data;
  return (
    <section aria-label="Jira sync" className="sync-panel">
      <h4>Jira sync</h4>
      {s?.state === 'not_configured' && (
        <p>
          Jira not configured: jira_base_url is empty. Set jira_base_url in this section and click
          Save Jira connection to start syncing.
        </p>
      )}
      {s?.state === 'error' && <p className="error">{s.lastError}</p>}
      {s && (
        <p>
          State: {s.state}
          {s.lastRunAt ? `, last run ${s.lastRunAt}` : ''}
          {s.lastResult ? ` (${s.lastResult})` : ''}
        </p>
      )}
      <button type="button" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
        Sync now
      </button>
    </section>
  );
}

const CREDENTIALS_HELP = (
  <p className="settings-help" data-testid="jira-credentials-help">
    Jira credentials are not entered here and are not stored by the app. The server reads{' '}
    <code>JIRA_EMAIL</code> (the e-mail of your Atlassian account) and <code>JIRA_API_TOKEN</code>{' '}
    (an API token created in your Atlassian account) from its environment. Set both before you start
    the server, and restart the server after you change them.
  </p>
);

export function Settings() {
  const q = useSettings();
  return (
    <section>
      <h2>Settings</h2>
      {q.error && (
        <div role="alert" className="error">
          {q.error.message}
        </div>
      )}
      {q.data?.problems.map((p) => (
        <div key={p.key} className="error">
          {p.key}: {p.message}
        </div>
      ))}
      {q.data &&
        SECTIONS.map((sec, i) => (
          <Section
            key={sec.title}
            title={sec.title}
            keys={sec.keys}
            values={q.data.values}
            readOnlyKeys={q.data.readOnly}
            intro={
              i === 0 ? (
                <>
                  {CREDENTIALS_HELP}
                  <SyncPanel />
                </>
              ) : undefined
            }
          />
        ))}
    </section>
  );
}
