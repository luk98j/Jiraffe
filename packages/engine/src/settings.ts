import {
  SETTINGS,
  SETTING_KEYS,
  ValidationError,
  parseSetting,
  type SettingKey,
  type SettingValue,
  type SettingsDto,
} from '@jiraffe/core';
import { insertJournal, readSettingRows, upsertSetting } from '@jiraffe/db';
import { write, type Ctx } from './context.ts';

/** Reads on every call (no cache) so changes apply without a restart. Bad stored values fall back to the default. */
export function readSettings(ctx: Ctx): SettingsDto {
  const stored = new Map(readSettingRows(ctx.db).map((r) => [r.key, r.valueJson]));
  const values: Record<string, unknown> = {};
  const problems: SettingsDto['problems'] = [];
  for (const key of SETTING_KEYS) {
    const json = stored.get(key);
    if (json === undefined) {
      values[key] = SETTINGS[key].default;
      continue;
    }
    let parsed: ReturnType<typeof parseSetting<SettingKey>>;
    try {
      parsed = parseSetting(key, JSON.parse(json));
    } catch {
      parsed = { ok: false, message: 'Stored value is not valid JSON' };
    }
    if (parsed.ok) values[key] = parsed.value;
    else {
      values[key] = SETTINGS[key].default;
      problems.push({
        key,
        message: `Stored value is invalid, using the default: ${parsed.message}`,
      });
    }
  }
  const readOnly = SETTING_KEYS.filter((k) => 'readOnly' in SETTINGS[k]);
  return { values, readOnly, problems };
}

export function getSetting<K extends SettingKey>(ctx: Ctx, key: K): SettingValue<K> {
  return readSettings(ctx).values[key] as SettingValue<K>;
}

export function updateSetting(ctx: Ctx, key: string, raw: unknown): void {
  if (!(key in SETTINGS)) throw new ValidationError(`Unknown setting "${key}"`, key);
  const k = key as SettingKey;
  if ('readOnly' in SETTINGS[k]) throw new ValidationError(`Setting "${key}" is read-only`, key);
  const parsed = parseSetting(k, raw);
  if (!parsed.ok) throw new ValidationError(parsed.message, key);
  write(ctx, (tx, outbox) => {
    upsertSetting(tx, key, JSON.stringify(parsed.value));
    insertJournal(tx, { at: ctx.clock().toISOString(), action: 'settings_changed', detail: key });
    outbox.changed();
  });
}
