import { describe, expect, it } from 'vitest';
import { SETTINGS, parseSetting } from '../src/index.ts';

// Section 10 defaults, written out literally (AC-8).
const DEFAULTS: Record<string, unknown> = {
  auto_analysis: false,
  max_parallel_analysis: 2,
  max_parallel_execution: 2,
  default_max_credits: 2.0,
  quota_retry_minutes: 60,
  quota_error_patterns: [],
  jira_base_url: '',
  jira_projects: [],
  jira_ignored_statuses: [],
  jira_tasks_sync_minutes: 30,
  jira_comments_sync_minutes: 30,
  repo_map: {},
  worktrees_dir: '../.worktrees',
  allowed_tools: ['git status', 'git diff', 'git add', 'git commit', 'gradle test'],
  retention_days: 28,
  journal_retention_days: null,
  local_task_counter: 0,
};

describe('settings schema', () => {
  it('has exactly the section 10 keys with their defaults', () => {
    expect(Object.keys(SETTINGS).sort()).toEqual(Object.keys(DEFAULTS).sort());
    for (const [key, def] of Object.entries(DEFAULTS)) {
      expect(SETTINGS[key as keyof typeof SETTINGS].default, key).toEqual(def);
    }
  });

  it('every default passes its own schema', () => {
    for (const key of Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]) {
      expect(parseSetting(key, SETTINGS[key].default).ok, key).toBe(true);
    }
  });

  it('rejects invalid values', () => {
    expect(parseSetting('max_parallel_analysis', 0).ok).toBe(false);
    expect(parseSetting('max_parallel_analysis', 'x').ok).toBe(false);
    expect(parseSetting('max_parallel_analysis', 1.5).ok).toBe(false);
    expect(parseSetting('retention_days', -1).ok).toBe(false);
    expect(parseSetting('default_max_credits', 0).ok).toBe(false);
    expect(parseSetting('auto_analysis', 'yes').ok).toBe(false);
    expect(parseSetting('journal_retention_days', 0).ok).toBe(false);
    expect(parseSetting('jira_base_url', 'ftp://x').ok).toBe(false);
    expect(parseSetting('repo_map', { A: '' }).ok).toBe(false);
    expect(parseSetting('allowed_tools', ['']).ok).toBe(false);
    expect(parseSetting('worktrees_dir', '').ok).toBe(false);
  });

  it('accepts valid values', () => {
    expect(parseSetting('max_parallel_analysis', 3)).toEqual({ ok: true, value: 3 });
    expect(parseSetting('journal_retention_days', null)).toEqual({ ok: true, value: null });
    expect(parseSetting('journal_retention_days', 30)).toEqual({ ok: true, value: 30 });
    expect(parseSetting('jira_base_url', 'https://x.atlassian.net/')).toEqual({
      ok: true,
      value: 'https://x.atlassian.net',
    });
    expect(parseSetting('jira_base_url', '')).toEqual({ ok: true, value: '' });
  });

  it('normalises jira_ignored_statuses', () => {
    expect(parseSetting('jira_ignored_statuses', [' Blocked ', '', 'Blocked', "Won't do"])).toEqual({
      ok: true,
      value: ['Blocked', "Won't do"],
    });
  });

  it('jira_projects rejects spaces and quotes', () => {
    expect(parseSetting('jira_projects', ['PROJ', 'ABC_1']).ok).toBe(true);
    for (const bad of ['A B', 'A"B', "A'B", 'A)', '1A', '']) {
      expect(parseSetting('jira_projects', [bad]).ok, bad).toBe(false);
    }
  });

  it('marks local_task_counter read-only and returns an error message on failure', () => {
    expect(SETTINGS.local_task_counter.readOnly).toBe(true);
    const r = parseSetting('retention_days', -1);
    expect(r.ok === false && r.message.length > 0).toBe(true);
  });
});
