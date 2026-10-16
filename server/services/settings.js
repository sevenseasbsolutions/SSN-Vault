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

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  const rows = query('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  cache = out;
  return out;
}

export const getSetting = (key) => loadSettings()[key];
export const invalidateSettings = () => { cache = null; };

export function setSetting(key, value, actorId) {
  execute(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($key, $value, $updated_by, $updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    { key, value: String(value), updated_by: actorId ?? null, updated_at: nowIso() }
  );
  invalidateSettings();
}

export const isDemoMode = () => getSetting('demo_mode') === 'true';

/** Whether the owner has enabled record deletion. */
export const deletionAllowed = () => getSetting('allow_delete') === 'true';
