import { z } from 'zod';

const posInt = z.number().int().min(1);
const nonEmpty = z.string().trim().min(1);

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Credentials are sent to this URL, so it must be https (http only for a local test server). */
function isAllowedBaseUrl(v: string): boolean {
  if (v === '') return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname));
  } catch {
    return false;
  }
}

const url = z
  .string()
  .trim()
  .refine(isAllowedBaseUrl, 'Must be empty or an https URL (http is allowed only for localhost)')
  .transform((v) => v.replace(/\/+$/, ''));

interface Def<S extends z.ZodType> {
  schema: S;
  default: z.output<S>;
  input: 'boolean' | 'number' | 'text' | 'json';
  readOnly?: true;
}
const def = <S extends z.ZodType>(d: Def<S>) => d;

/** One schema for defaults and validation, shared by engine, API and UI. */
export const SETTINGS = {
  auto_analysis: def({ schema: z.boolean(), default: false, input: 'boolean' }),
  max_parallel_analysis: def({ schema: posInt, default: 2, input: 'number' }),
  max_parallel_execution: def({ schema: posInt, default: 2, input: 'number' }),
  default_max_credits: def({ schema: z.number().positive(), default: 2.0, input: 'number' }),
  quota_retry_minutes: def({ schema: posInt, default: 60, input: 'number' }),
  quota_error_patterns: def({ schema: z.array(nonEmpty), default: [] as string[], input: 'json' }),
  jira_base_url: def({ schema: url, default: '', input: 'text' }),
  jira_projects: def({
    schema: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Invalid Jira project key')),
    default: [] as string[],
    input: 'json',
  }),
  jira_ignored_statuses: def({
    schema: z
      .array(z.string())
      .transform((l) => [...new Set(l.map((s) => s.trim()).filter((s) => s !== ''))]),
    default: [] as string[],
    input: 'json',
  }),
  jira_tasks_sync_minutes: def({ schema: posInt.max(1440), default: 30, input: 'number' }),
  jira_comments_sync_minutes: def({ schema: posInt.max(1440), default: 30, input: 'number' }),
  repo_map: def({
    schema: z.record(z.string(), nonEmpty),
    default: {} as Record<string, string>,
    input: 'json',
  }),
  worktrees_dir: def({ schema: nonEmpty, default: '../.worktrees', input: 'text' }),
  allowed_tools: def({
    schema: z.array(nonEmpty),
    default: ['git status', 'git diff', 'git add', 'git commit', 'gradle test'],
    input: 'json',
  }),
  retention_days: def({ schema: posInt, default: 28, input: 'number' }),
  journal_retention_days: def({
    schema: posInt.nullable(),
    default: null as number | null,
    input: 'number',
  }),
  local_task_counter: def({
    schema: z.number().int().min(0),
    default: 0,
    input: 'number',
    readOnly: true,
  }),
};

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export type ParseResult<K extends SettingKey> =
  | { ok: true; value: SettingValue<K> }
  | { ok: false; message: string };

export function parseSetting<K extends SettingKey>(key: K, raw: unknown): ParseResult<K> {
  const r = SETTINGS[key].schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data as SettingValue<K> };
  return { ok: false, message: r.error.issues.map((i) => i.message).join('; ') };
}
