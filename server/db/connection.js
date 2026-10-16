import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

/*
 * Money is stored in BIGINT cents and counts come back as BIGINT. node-postgres
 * returns both as strings by default, to be safe past 2^53; cents never get
 * near that, and every caller does arithmetic on them, so they come back as
 * numbers. NUMERIC (what SUM over BIGINT returns) likewise.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

/**
 * Connection settings: DATABASE_URL, or the discrete DB_* variables.
 *
 * DATABASE_SCHEMA puts every query in one schema. The test harness uses it to
 * give each test file a throwaway schema of its own; a deployment leaves it
 * unset and uses `public`.
 */
export function connectionConfig() {
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'ssn_vault',
      user: process.env.DB_USER ?? 'ssn_vault',
      password: process.env.DB_PASSWORD,
    };
  if (process.env.DB_SSL === 'true') config.ssl = { rejectUnauthorized: false };
  const schema = process.env.DATABASE_SCHEMA;
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DATABASE_SCHEMA must be a plain lowercase identifier');
    config.options = `-c search_path=${schema}`;
  }
  return config;
}

/** Where the data lives, for the startup log. Never includes the password. */
export function describeDatabase() {
  const c = connectionConfig();
  if (c.connectionString) {
    try {
      const url = new URL(c.connectionString);
      return `postgres://${url.username}@${url.host}${url.pathname}`;
    } catch { return 'postgres (DATABASE_URL)'; }
  }
  return `postgres://${c.user}@${c.host}:${c.port}/${c.database}`;
}

let pool = null;

export function getDb() {
  if (pool) return pool;
  pool = new pg.Pool({
    ...connectionConfig(),
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client losing its connection must not take the process down.
  pool.on('error', (err) => { console.error('Postgres pool error:', err.message); });
  return pool;
}

export async function closeDb() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

/* ------------------------------------------------------------- parameters -- */

/*
 * The SQL in this codebase names its parameters ($id, $month). Postgres wants
 * them numbered ($1, $2), so each statement is rewritten once and cached.
 * String literals, quoted identifiers and comments are skipped, so a '$' inside
 * them is never mistaken for a parameter. The same name used twice maps to the
 * same number, so Postgres infers one type for it.
 */
const compiled = new Map();

function compile(sql) {
  let hit = compiled.get(sql);
  if (hit) return hit;
  const names = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '$' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))[0];
      let index = names.indexOf(name);
      if (index < 0) { names.push(name); index = names.length - 1; }
      out += `$${index + 1}`;
      i += 1 + name.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  hit = { text: out, names };
  compiled.set(sql, hit);
  return hit;
}

/** Bind the way SQLite did: a missing value or a non-finite number is NULL. */
function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/* ----------------------------------------------------------- transactions -- */

/*
 * The client of the transaction this code is running inside, if any. Every
 * query issued while a transaction is open goes through its client, however
 * deep in the call stack, so a helper called from a transaction is part of it
 * without anyone having to pass a handle down.
 */
const context = new AsyncLocalStorage();

/*
 * Writers are serialised by one transaction-scoped advisory lock. That is what
 * SQLite's BEGIN IMMEDIATE gave this application, and what its checks were
 * written against: "does a main company exist yet", "is the next reference
 * free" are read and then acted on, and must not interleave with another
 * writer doing the same. Readers never take it.
 */
const WRITE_LOCK = 0x55a17;

async function run(sql, params = {}) {
  const { text, names } = compile(sql);
  const values = names.map((name) => bindValue(params[name]));
  const store = context.getStore();
  const target = store?.client ?? getDb();
  return target.query(text, values);
}

export const query = async (sql, params = {}) => (await run(sql, params)).rows;
export const queryOne = async (sql, params = {}) => (await run(sql, params)).rows[0] ?? null;

/**
 * Run a statement for its effect. An INSERT that should report its new id
 * says `RETURNING id`; the id comes back as `lastInsertRowid`.
 */
export async function execute(sql, params = {}) {
  const result = await run(sql, params);
  return {
    changes: result.rowCount ?? 0,
    rows: result.rows,
    lastInsertRowid: result.rows?.[0]?.id ?? null,
  };
}

/** Run raw SQL (several statements, no parameters): migrations only. */
export async function exec(sql) {
  const store = context.getStore();
  await (store?.client ?? getDb()).query(sql);
}

async function withClient(begin, fn, { lock }) {
  const client = await getDb().connect();
  let broken = null;
  try {
    await client.query(begin);
    if (lock) await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const result = await context.run({ client, readOnly: !lock, savepoints: 0 }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { broken = rollbackErr; }
    throw err;
  } finally {
    // A client whose rollback failed is in an unknown state: discard it.
    client.release(broken ?? undefined);
  }
}

/**
 * Run `fn` inside a write transaction. Financial writes that touch more than
 * one row go through this, so a half-applied update is impossible. Nested
 * calls join the transaction already open.
 */
export function transaction(fn) {
  const store = context.getStore();
  if (store) {
    if (store.readOnly) throw new Error('A write was attempted inside a read-only snapshot');
    return fn();
  }
  return withClient('BEGIN', fn, { lock: true });
}

/**
 * Run `fn` against one consistent snapshot of the database.
 *
 * A report is many queries -- salaries, then expenses, then overrides, for
 * each SSN and month -- and under SQLite nothing could change between them.
 * REPEATABLE READ keeps that true here: every query sees the database as it
 * was when the first one ran, so a total can never mix before and after.
 */
export function snapshot(fn) {
  if (context.getStore()) return fn();
  return withClient('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn, { lock: false });
}

/**
 * Run `fn` so that, inside a transaction, its failure undoes only its own work.
 *
 * Postgres aborts a whole transaction on the first failed statement, so a
 * caller that catches an error and carries on (retrying an insert that lost a
 * race for a reference number) needs a savepoint to carry on from.
 */
export async function savepoint(fn) {
  const store = context.getStore();
  if (!store) return fn();
  store.savepoints += 1;
  const name = `sp_${store.savepoints}`;
  await store.client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await store.client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await store.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/* ----------------------------------------------------------------- errors -- */

/** Postgres SQLSTATE 23505: a unique index refused the row. */
export function isUniqueViolation(err) {
  return err?.code === '23505';
}
