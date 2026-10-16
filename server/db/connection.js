import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

export function resolveDbPath() {
  const configured = process.env.DATABASE_PATH;
  if (configured === ':memory:') return ':memory:';
  if (configured) return path.resolve(ROOT, configured);
  return path.join(ROOT, 'data', 'vault.db');
}

let db = null;

export function getDb() {
  if (db) return db;
  const target = resolveDbPath();
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (target !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

/** Reset the module-level handle (used by the test harness between files). */
export function resetDbHandle() { db = null; }

const plain = (row) => (row ? { ...row } : row);

export const query = (sql, params = {}) => getDb().prepare(sql).all(params).map(plain);
export const queryOne = (sql, params = {}) => plain(getDb().prepare(sql).get(params)) ?? null;
export const execute = (sql, params = {}) => getDb().prepare(sql).run(params);

/**
 * Run `fn` inside a transaction. Financial writes that touch more than one row
 * (distribution runs, expense allocations, payments) all go through this, so a
 * half-applied financial update is impossible.
 */
export function transaction(fn) {
  const handle = getDb();
  // SQLite does not support nested transactions; reuse the outer one.
  if (handle.isTransaction) return fn();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Translate SQLite constraint failures into a friendly message. */
export function isUniqueViolation(err) {
  return typeof err?.message === 'string' && /UNIQUE constraint failed/i.test(err.message);
}
