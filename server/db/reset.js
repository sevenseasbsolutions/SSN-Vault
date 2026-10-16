import fs from 'node:fs';
import readline from 'node:readline/promises';
import { resolveDbPath, closeDb } from './connection.js';

/**
 * Destructive: deletes the database file. Requires an explicit confirmation,
 * or --yes for scripted use. Back up data/vault.db first if it matters.
 */
const target = resolveDbPath();

if (target === ':memory:') {
  console.log('DATABASE_PATH is :memory: — nothing to delete.');
  process.exit(0);
}

const confirmed = process.argv.includes('--yes');
if (!confirmed) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This permanently deletes ${target} and every financial record in it.\nType DELETE to confirm: `
  );
  rl.close();
  if (answer.trim() !== 'DELETE') {
    console.log('Cancelled. Nothing was deleted.');
    process.exit(1);
  }
}

closeDb();
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${target}${suffix}`;
  if (fs.existsSync(file)) { fs.rmSync(file); console.log(`Deleted ${file}`); }
}
console.log('Done. Run "npm start" to recreate the database.');
