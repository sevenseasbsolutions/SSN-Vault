/**
 * Test harness.
 *
 * Every test file gets its own throwaway SQLite database and its own HTTP
 * server on an ephemeral port, so tests never share state. DATABASE_PATH is
 * set before the database module is imported, which is why the server modules
 * are loaded through a dynamic import below.
 *
 * Test files should import ONLY from this module, so the ordering guarantee
 * holds.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
process.env.DATABASE_PATH = path.join(workDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.OWNER_EMAIL = 'owner@test.local';
process.env.OWNER_PASSWORD = 'OwnerPassword-2026!';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.SESSION_TTL_HOURS = '2';

export const OWNER = { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD };

const { createApp } = await import('../server/app.js');
const { migrate } = await import('../server/db/migrate.js');
const { ensureBaseline } = await import('../server/db/seed.js');
const connection = await import('../server/db/connection.js');
const rollup = await import('../server/services/rollup.js');
const settingsService = await import('../server/services/settings.js');
const money = await import('../server/lib/money.js');
const dates = await import('../server/lib/dates.js');

export const db = connection;
export const { query, queryOne, execute } = connection;
export { rollup, settingsService, money, dates };

let server = null;
let baseUrl = null;

/** Boot the database and HTTP server once per test file. */
export async function boot() {
  if (server) return baseUrl;
  connection.getDb();
  migrate({ silent: true });
  ensureBaseline();
  // Quiet logger: an expected 500 in a negative test should not spam output.
  const app = createApp({ logger: { error: () => {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function shutdown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  try { connection.closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** A cookie-jar HTTP client that carries the session and CSRF token. */
export function createClient() {
  const jar = new Map();
  let csrf = '';

  const request = async (method, pathname, body) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar.values()].join('; ');
    if (csrf) headers['x-csrf-token'] = csrf;

    const response = await fetch(baseUrl + pathname, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const name = pair.split('=')[0];
      if (/Max-Age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, pair);
    }
    const cookieCsrf = /vault_csrf=([^;]*)/.exec([...jar.values()].join('; '));
    if (cookieCsrf) csrf = decodeURIComponent(cookieCsrf[1]);

    const text = await response.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    return { status: response.status, body: json, headers: response.headers, text };
  };

  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    put: (p, b) => request('PUT', p, b ?? {}),
    del: (p, b) => request('DELETE', p, b ?? {}),
    async login(email, password) {
      const result = await request('POST', '/api/auth/login', { email, password });
      if (result.status !== 200) {
        throw new Error(`login failed for ${email}: ${result.status} ${JSON.stringify(result.body)}`);
      }
      return result.body;
    },
    /** Drop the session without hitting the server, to test anonymous access. */
    forget() { jar.clear(); csrf = ''; },
  };
}

export async function ownerClient() {
  const client = createClient();
  await client.login(OWNER.email, OWNER.password);
  return client;
}

/* ------------------------------------------------------------- fixtures -- */

const unique = () => crypto.randomBytes(4).toString('hex');

/**
 * Build an isolated company tree: its own main company is reused if one
 * exists (there can only be one), with a fresh sub-company and SSNs
 * underneath, so tests cannot interfere with one another.
 */
export async function makeWorld(client, {
  shareBps = 3000, taxRateBps = 1000, ssns: extraSsns = [],
} = {}) {
  const tag = unique();

  // Exactly one main company may exist, so reuse it when a previous world in
  // the same file already created it.
  const existing = await client.get('/api/org');
  let mainId = existing.body.main?.id ?? null;
  if (!mainId) {
    const main = await client.post('/api/org', { name: `MBS ${tag}`, kind: 'main' });
    assertCreated(main, 'main company');
    mainId = main.body.unit.id;
  }

  const sub = await client.post('/api/org', {
    name: `Sub ${tag}`, kind: 'sub', parent_id: mainId,
  });
  assertCreated(sub, 'sub-company');
  const subId = sub.body.unit.id;

  const ssn = await client.post('/api/org', {
    name: `SSN ${tag}`, kind: 'ssn', parent_id: subId,
    share: shareBps / 100,
  });
  assertCreated(ssn, 'SSN');

  const extras = [];
  for (const spec of extraSsns) {
    const extraTag = unique();
    const created = await client.post('/api/org', {
      name: spec.name ?? `SSN ${extraTag}`, kind: 'ssn', parent_id: spec.subId ?? subId,
      share: (spec.shareBps ?? shareBps) / 100,
    });
    assertCreated(created, `extra SSN ${spec.name}`);
    extras.push({
      ssnId: created.body.unit.id,
      shareBps: spec.shareBps ?? shareBps,
      taxRateBps: spec.taxRateBps ?? taxRateBps,
    });
  }

  const categories = await client.get('/api/expenses/meta/categories');

  return {
    tag,
    mainId,
    subId,
    ssnId: ssn.body.unit.id,
    shareBps,
    taxRateBps,
    categoryId: categories.body.rows[0].id,
    extras,
  };
}

export function assertCreated(result, what) {
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`Failed to create ${what}: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

/**
 * Set up a job: an engagement under an SSN. It holds no money.
 *
 * `taxPercent` is the hold applied to each of its salaries' CREDITED amounts,
 * and `category` is 'w2' or '1099'. Returns the created job row.
 */
export async function addJob(client, world, {
  ssnId, title, client: clientName, category = 'w2', taxPercent, joined = '2026-01-01',
} = {}) {
  const result = await client.post('/api/jobs', {
    ssn_id: ssnId ?? world.ssnId,
    title: title ?? 'test job',
    client_name: clientName ?? null,
    tax_category: category,
    tax_hold: taxPercent ?? world.taxRateBps / 100,
    joining_date: joined,
  });
  assertCreated(result, 'job');
  return result.body.job;
}

/**
 * Record one month's money on a job.
 *
 * `credited` defaults to `invoice`, which is the ordinary 1099 case: the whole
 * amount arrives and nothing is withheld.
 */
export const addSalary = (client, {
  jobId, month, invoice, credited, date, status, periodFrom, periodTo,
}) => client.post('/api/salaries', {
  job_id: jobId,
  accounting_month: month,
  invoice_amount: invoice,
  credited_amount: credited ?? invoice,
  credit_date: date ?? `${month}-15`,
  // Optional in the model, so only sent when a test asks for one.
  pay_period_from: periodFrom ?? null,
  pay_period_to: periodTo ?? null,
  status,
});

/**
 * Set up a job and pay it in one go -- the common case in these tests.
 * Returns the salary response.
 */
export async function addJobWithSalary(client, world, {
  month, invoice, credited, taxPercent, category, ssnId, title, status,
}) {
  const job = await addJob(client, world, { ssnId, title, category, taxPercent });
  return addSalary(client, { jobId: job.id, month, invoice, credited, status });
}

/** Record an expense charged to an SSN. */
export const addExpense = (client, world, {
  month, date, amount, ssnId, categoryId, status, description,
}) => client.post('/api/expenses', {
  ssn_id: ssnId ?? world.ssnId,
  accounting_month: month,
  expense_date: date ?? `${month}-15`,
  amount,
  category_id: categoryId ?? world.categoryId,
  description: description ?? 'test expense',
  status,
});

/** Override an SSN's tax hold for one month. */
export const overrideTax = (client, world, { month, amount, reason, ssnId }) =>
  client.put('/api/tax/overrides', {
    ssn_id: ssnId ?? world.ssnId,
    accounting_month: month,
    amount,
    reason: reason ?? 'test override',
  });

/** An SSN's computed statement for a month. */
export const statement = (client, world, month, ssnId) =>
  client.get(`/api/org/${ssnId ?? world.ssnId}/statement?month=${month}`);

/** Cents helper so expectations read in currency units. */
export const cents = (value) => money.toCents(value);

/** Create a secondary user with a role, optional scopes and permissions. */
export async function makeUser(client, { role, scopes = [], permissions = [], name } = {}) {
  const tag = unique();
  const email = `${role}-${tag}@test.local`;
  const password = `Test-${tag}-Password1!`;
  const result = await client.post('/api/users', {
    name: name ?? `${role} ${tag}`, email, role, password, scopes, permissions,
  });
  assertCreated(result, `user ${email}`);
  const session = createClient();
  await session.login(email, password);
  return { id: result.body.user.id, email, password, client: session };
}
