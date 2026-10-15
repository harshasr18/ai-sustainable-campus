/**
 * Runtime configuration that lives in the database rather than in code.
 *
 * The brief is explicit that the 72-hour overdue threshold must be "configurable
 * rather than hardcoded throughout the codebase". It is stored once in
 * app_settings and read through this module. Changing it is a data change, not a
 * redeploy.
 */
import type { Db, Tx } from './driver.js';

export const SETTING_KEYS = {
  OVERDUE_HOURS: 'overdue_hours',
  TOKENS_PER_VALIDATED_REPORT: 'tokens_per_validated_report',
} as const;

type Conn = Db | Tx;

export async function getNumberSetting(db: Conn, key: string, fallback: number): Promise<number> {
  const r = await db.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  if (r.rows.length === 0) return fallback;

  const raw = r.rows[0]!.value;
  // jsonb may arrive pre-parsed (both pg and PGlite) or as a string.
  const parsed = typeof raw === 'string' ? Number(JSON.parse(raw)) : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`app_settings["${key}"] must be a positive number, received: ${String(raw)}`);
  }
  return parsed;
}

/** Overdue threshold in hours. Used to compute due_at and the `overdue` flag. */
export const getOverdueHours = (db: Conn): Promise<number> =>
  getNumberSetting(db, SETTING_KEYS.OVERDUE_HOURS, 72);

/** Reward amount per validated report. Never hardcoded in a route handler. */
export const getTokensPerValidatedReport = (db: Conn): Promise<number> =>
  getNumberSetting(db, SETTING_KEYS.TOKENS_PER_VALIDATED_REPORT, 10);

export async function setNumberSetting(db: Conn, key: string, value: number): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::numeric), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}
