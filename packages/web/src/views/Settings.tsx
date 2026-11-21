import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SETTINGS, SETTING_KEYS, type SettingKey } from '@jiraffe/core';
import { request } from '../api.ts';
import { useApiMutation, useSettings, useSync } from '../queries.ts';

const toDraft = (key: SettingKey, stored: unknown): string | boolean => {
  const kind = SETTINGS[key].input;
  if (kind === 'boolean') return stored === true;
  if (kind === 'json') return JSON.stringify(stored, null, 2);
  return stored === null || stored === undefined ? '' : String(stored);
};

function Row({ name, stored, readOnly }: { name: SettingKey; stored: unknown; readOnly: boolean }) {
  const qc = useQueryClient();
  const kind = SETTINGS[name].input;
  const serialized = JSON.stringify(stored);
  const [draft, setDraft] = useState<string | boolean>(() => toDraft(name, stored));
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setDraft(toDraft(name, JSON.parse(serialized ?? 'null'))), [name, serialized]);

  const save = useMutation({
    mutationFn: (value: unknown) => request('PUT', `/api/settings/${name}`, { value }),
    onSuccess: () => setStatus({ ok: true, text: 'Saved' }),
    onError: (e: Error) => {
      setStatus({ ok: false, text: e.message });
      setDraft(toDraft(name, stored)); // keep showing the stored value
    },
    onSettled: () => qc.invalidateQueries(),
  });

  const submit = () => {
    setStatus(null);
    let value: unknown;
    if (kind === 'boolean') value = draft;
    else if (kind === 'number') value = String(draft).trim() === '' ? null : Number(draft);
    else if (kind === 'json') {
      try {
        value = JSON.parse(String(draft));
      } catch {
        setStatus({ ok: false, text: 'Invalid JSON' });
        return;
      }
    } else value = draft;
    save.mutate(value);
  };

  const id = `setting-${name}`;
  return (
    <div className="setting-row">
      <label htmlFor={id}>{name}</label>
      {kind === 'boolean' && <input id={id} type="checkbox" checked={draft === true} disabled={readOnly} onChange={(e) => setDraft(e.target.checked)} />}
      {kind === 'number' && <input id={id} type="number" value={String(draft)} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} />}
      {kind === 'text' && <input id={id} value={String(draft)} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} />}
      {kind === 'json' && <textarea id={id} rows={3} value={String(draft)} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} />}
      {readOnly ? <small>Read-only</small> : <button type="button" onClick={submit} disabled={save.isPending}>{`Save ${name}`}</button>}
      {status && <span role={status.ok ? 'status' : undefined} className={status.ok ? 'ok' : 'error'}>{status.text}</span>}
    </div>
  );
}

export function SyncPanel() {
  const q = useSync();
  const run = useApiMutation(() => request('POST', '/api/sync'));
  const s = q.data;
  return (
    <section aria-label="Jira sync" className="sync-panel">
      <h3>Jira sync</h3>
      {s?.state === 'not_configured' && <p>Jira not configured</p>}
      {s?.state === 'error' && <p className="error">{s.lastError}</p>}
      {s && <p>State: {s.state}{s.lastRunAt ? `, last run ${s.lastRunAt}` : ''}{s.lastResult ? ` (${s.lastResult})` : ''}</p>}
      <button type="button" onClick={() => run.mutate(undefined)} disabled={run.isPending}>Sync now</button>
    </section>
  );
}

export function Settings() {
  const q = useSettings();
  return (
    <section>
      <h2>Settings</h2>
      <SyncPanel />
      {q.error && <div role="alert" className="error">{q.error.message}</div>}
      {q.data?.problems.map((p) => (
        <div key={p.key} className="error">{p.key}: {p.message}</div>
      ))}
      {q.data && SETTING_KEYS.map((k) => (
        <Row key={k} name={k} stored={q.data.values[k]} readOnly={q.data.readOnly.includes(k) || 'readOnly' in SETTINGS[k]} />
      ))}
    </section>
  );
}
