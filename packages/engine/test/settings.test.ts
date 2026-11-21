import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS, SETTING_KEYS, ValidationError } from '@jiraffe/core';
import { disposeAll, makeEngine } from './helpers.ts';

afterEach(disposeAll);

describe('settings through the engine', () => {
  it('seeds every default on first start (AC-8)', () => {
    const { engine } = makeEngine();
    const s = engine.readSettings();
    expect(s.problems).toEqual([]);
    for (const k of SETTING_KEYS) expect(s.values[k], k).toEqual(SETTINGS[k].default);
    expect(s.readOnly).toEqual(['local_task_counter']);
  });

  it('keeps a changed value across a restart (AC-9)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiraffe-restart-'));
    try {
      const a = makeEngine({}, dir);
      a.engine.updateSetting('max_parallel_analysis', 3);
      a.dispose();
      const b = makeEngine({}, dir);
      expect(b.engine.readSettings().values.max_parallel_analysis).toBe(3);
      expect(b.engine.getSetting('max_parallel_analysis')).toBe(3);
    } finally {
      disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies changes without a restart and journals the key name only', () => {
    const { engine } = makeEngine({ clock: () => new Date('2026-11-21T10:00:00.000Z') });
    engine.updateSetting('jira_base_url', 'https://secret-host.example.com/');
    expect(engine.getSetting('jira_base_url')).toBe('https://secret-host.example.com');
    const rows = engine.listJournal({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'settings_changed',
      taskKey: null,
      status: null,
      detail: 'jira_base_url',
      at: '2026-11-21T10:00:00.000Z',
    });
    expect(JSON.stringify(rows)).not.toContain('secret-host');
  });

  it('normalises list values on save', () => {
    const { engine } = makeEngine();
    engine.updateSetting('jira_ignored_statuses', [' Blocked ', 'Blocked', '']);
    expect(engine.getSetting('jira_ignored_statuses')).toEqual(['Blocked']);
  });

  it.each([0, 'x', 1.5, null])('rejects invalid max_parallel_analysis %j with no row', (bad) => {
    const { engine } = makeEngine();
    expect(() => engine.updateSetting('max_parallel_analysis', bad)).toThrow(ValidationError);
    expect(engine.getSetting('max_parallel_analysis')).toBe(2);
    expect(engine.listJournal({})).toEqual([]);
  });

  it('rejects local_task_counter and unknown keys with no row (AC-85)', () => {
    const { engine } = makeEngine();
    expect(() => engine.updateSetting('local_task_counter', 99)).toThrow(/read-only/);
    expect(() => engine.updateSetting('nope', 1)).toThrow(ValidationError);
    expect(engine.getSetting('local_task_counter')).toBe(0);
    expect(engine.listJournal({})).toEqual([]);
  });

  it('falls back to the default and reports a problem for stored garbage', () => {
    const { engine, raw } = makeEngine();
    raw.prepare("UPDATE settings SET value_json = '{not json' WHERE key = 'retention_days'").run();
    raw.prepare("UPDATE settings SET value_json = '0' WHERE key = 'max_parallel_analysis'").run();
    const s = engine.readSettings();
    expect(s.values.retention_days).toBe(28);
    expect(s.values.max_parallel_analysis).toBe(2);
    expect(s.problems.map((p) => p.key).sort()).toEqual(['max_parallel_analysis', 'retention_days']);
  });
});
