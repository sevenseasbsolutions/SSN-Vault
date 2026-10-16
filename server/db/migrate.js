import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, execute, exec, transaction, closeDb } from './connection.js';
import { nowIso } from '../lib/dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

/**
 * Forward-only migration runner.
 *
 * Migrations are plain .sql files named NNN_description.sql and applied in
 * numeric order. Applied versions are recorded in schema_migrations, so
 * running this against an existing database only applies what is missing and
 * never touches existing rows. The whole run is one transaction under the
 * write lock, so two processes starting at once cannot both apply a file, and
 * a failing migration leaves nothing half-applied.
 */
export async function migrate({ silent = false } = {}) {
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const run = await transaction(async () => {
    await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(
      (await query('SELECT version FROM schema_migrations')).map((r) => r.version)
    );

    const done = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await exec(sql);
      } catch (err) {
        throw new Error(`Migration ${version} failed: ${err.message}`);
      }
      await execute('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $applied_at)',
        { version, applied_at: nowIso() });
      done.push(version);
      if (!silent) console.log(`  applied ${version}`);
    }
    return done;
  });
  if (!silent && run.length === 0) console.log('  database already up to date');
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Running migrations...');
  await migrate();
  await closeDb();
  console.log('Done.');
}
