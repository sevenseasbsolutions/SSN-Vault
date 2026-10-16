import readline from 'node:readline/promises';
import { query, exec, transaction, closeDb, describeDatabase } from './connection.js';

/**
 * Destructive: drops every table in the application's schema. Requires an
 * explicit confirmation, or --yes for scripted use. Back the database up first
 * (pg_dump) if it matters.
 */
const target = describeDatabase();

const confirmed = process.argv.includes('--yes');
if (!confirmed) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This permanently drops every table in ${target} and every financial record in them.\n`
    + 'Type DELETE to confirm: '
  );
  rl.close();
  if (answer.trim() !== 'DELETE') {
    console.log('Cancelled. Nothing was deleted.');
    process.exit(1);
  }
}

const dropped = await transaction(async () => {
  const tables = (await query(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename'
  )).map((r) => r.tablename);
  if (tables.length) {
    await exec(`DROP TABLE ${tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ')} CASCADE`);
  }
  return tables;
});
await closeDb();

for (const table of dropped) console.log(`Dropped ${table}`);
console.log('Done. Run "npm start" to recreate the schema.');
