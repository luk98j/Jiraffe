import { eq } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { settings } from './schema.ts';

export function readSettingRows(db: Db | Tx): { key: string; valueJson: string }[] {
  return db.select().from(settings).all();
}

export function upsertSetting(tx: Db | Tx, key: string, valueJson: string): void {
  tx.insert(settings)
    .values({ key, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson } })
    .run();
}

export function readSettingValue(db: Db | Tx, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.valueJson;
}
