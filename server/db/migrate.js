import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb } from './connection.js';
import { nowIso } from '../lib/dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

/**
 * Forward-only migration runner.
 *
 * Migrations are plain .sql files named NNN_description.sql and applied in
 * numeric order inside a transaction. Applied versions are recorded in
 * schema_migrations, so running this against an existing database only applies
 * what is missing and never touches existing rows.
 */
export function migrate({ silent = false } = {}) {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const run = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $applied_at)')
        .run({ version, applied_at: nowIso() });
      db.exec('COMMIT');
      run.push(version);
      if (!silent) console.log(`  applied ${version}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed: ${err.message}`);
    }
  }
  if (!silent && run.length === 0) console.log('  database already up to date');
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Running migrations...');
  migrate();
  console.log('Done.');
}
