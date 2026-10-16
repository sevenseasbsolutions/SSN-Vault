import { query, execute } from '../db/connection.js';
import { nowIso } from '../lib/dates.js';

export const DEFAULT_SETTINGS = {
  org_name: 'Vault',
  currency_symbol: '$',
  currency_code: 'USD',
  /*
   * Deleting a financial record is off until the owner turns it on. Nothing in
   * the application deletes anything while this is 'false'; with it on, a
   * Delete action appears for users who already hold the destructive
   * permission, and every deletion is still recorded in the audit history.
   */
  allow_delete: 'false',
  demo_mode: 'false',
  fiscal_year_start_month: '1',
  require_reason_above_cents: '100000',
};

/*
 * Read fresh every time. It is one indexed read of a handful of rows, and a
 * process-wide cache would have to know about transactions: a setting changed
 * inside one that then rolls back must not linger in memory as if it had been
 * saved.
 */
export async function loadSettings() {
  const rows = await query('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export const getSetting = async (key) => (await loadSettings())[key];

export async function setSetting(key, value, actorId) {
  await execute(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($key, $value, $updated_by, $updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    { key, value: String(value), updated_by: actorId ?? null, updated_at: nowIso() }
  );
}

export const isDemoMode = async () => (await getSetting('demo_mode')) === 'true';

/** Whether the owner has enabled record deletion. */
export const deletionAllowed = async () => (await getSetting('allow_delete')) === 'true';
