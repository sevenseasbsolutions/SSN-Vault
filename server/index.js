import { createApp, startHousekeeping } from './app.js';
import { migrate } from './db/migrate.js';
import { closeDb, describeDatabase } from './db/connection.js';
import { ensureBaseline } from './db/seed.js';
import { loadSettings } from './services/settings.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '127.0.0.1';

console.log(`Database: ${describeDatabase()}`);
await migrate();
const baseline = await ensureBaseline();
if (baseline.ownerPassword) {
  console.log('\n' + '='.repeat(66));
  console.log('  First run: an owner account has been created.');
  console.log(`  Email:    ${baseline.ownerEmail}`);
  console.log(`  Password: ${baseline.ownerPassword}`);
  console.log('  You will be asked to change this password after signing in.');
  console.log('='.repeat(66) + '\n');
}

const app = createApp();
startHousekeeping();

const settings = await loadSettings();
const server = app.listen(PORT, HOST, () => {
  console.log(`${settings.org_name} is running at http://${HOST}:${PORT}`);
  if (settings.demo_mode === 'true') console.log('Demo mode is ON. Demo records are labelled in the UI.');
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => { closeDb().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
