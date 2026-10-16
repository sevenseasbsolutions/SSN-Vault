/**
 * ============================================================================
 * THE financial calculation engine.
 * ============================================================================
 *
 * Every monetary total in this application -- dashboard cards, statements,
 * reports, exports -- is produced here. No route handler and no frontend
 * component re-implements a financial formula.
 *
 * The flow, per SSN, per accounting month:
 *
 *   A JOB is a standing engagement: an SSN, a client, a tax category
 *   ('w2' or '1099'), a tax-hold percentage and a joining date. It holds no
 *   money. The money arrives as SALARIES -- one per month, many per job.
 *
 *   Per salary:
 *       invoice           what was billed
 *     - credited          what actually arrived
 *     = withheld          kept by the hiring company under W2. RECORDED, and
 *                         never deducted again: it never reached the SSN, so
 *                         subtracting it twice would double-count it.
 *
 *       credited
 *     - the job's hold %  of credited, not of the invoice
 *     = to the SSN
 *
 *   Per SSN, per month:
 *       sum of that across its salaries
 *     - the SSN's expenses
 *     = remaining
 *     -> keep             share_bps of it stays with the SSN
 *     -> upstream         the remainder goes to its sub-company
 *
 * Then the tree is walked upward: a sub-company collects the upstream amounts
 * of its SSNs, and the main company receives the sub-companies' totals.
 *
 * Documented accounting assumptions
 * ---------------------------------
 * 1. A salary and an expense belong to the accounting month a user assigned to
 *    them. A job's joining date and a salary's credit date are descriptive;
 *    they never move money into a different month.
 * 2. Only salaries with status 'active' count. 'draft' is not yet real;
 *    'void' has been reversed. A job being inactive does not retrospectively
 *    remove salaries already recorded against it.
 * 3. Only expenses with status 'approved' are deducted.
 * 4. The tax hold is taken per SALARY, from the credited amount, at the rate
 *    its job carries -- so two salaries in one month can be held at different
 *    rates. Each is truncated on its own before being summed, so the monthly
 *    figure is exactly the sum of the lines a statement lists.
 * 5. The hold comes off BEFORE the SSN's expenses, because tax is owed on what
 *    was earned rather than on what is left after the SSN's own costs. It is
 *    clamped to the credited total, so it can never exceed the money it is
 *    held out of; an override is clamped the same way.
 * 6. keep + upstream == distributable, to the cent, always. `keep` is the
 *    truncated share and `upstream` is the exact residual, so no cent is
 *    created or lost by rounding -- see `splitDistributable`.
 * 7. A loss stays where it was made. If distributable is negative the SSN
 *    carries all of it and nothing flows upstream: an SSN having a bad month
 *    must not reach into its parent's pocket, and the parent must not be shown
 *    income that does not exist.
 * 8. A sub-company keeps nothing. It is a collection point, so what it passes
 *    to the main company always equals what it collected.
 */

import { query, queryOne } from '../db/connection.js';
import { applyBps, sum } from '../lib/money.js';
import { toMonth, monthRange } from '../lib/dates.js';
import { mapSeries } from '../lib/async.js';

const COUNTED_SALARY_STATUS = 'active';
const COUNTED_EXPENSE_STATUS = 'approved';

/* ------------------------------------------------------------------ tree -- */

/** The single main company, or null before one has been created. */
export const mainUnit = () =>
  queryOne("SELECT * FROM org_units WHERE kind = 'main' ORDER BY id LIMIT 1");

export const unitById = (id) =>
  queryOne('SELECT * FROM org_units WHERE id = $id', { id: Number(id) });

export const childrenOf = (parentId) =>
  query(`SELECT * FROM org_units WHERE parent_id = $parent ORDER BY lower(name), name`,
    { parent: Number(parentId) });

/**
 * Every unit, each with its depth and the path of ids from the root.
 *
 * One recursive query rather than a query per level, so rendering the tree
 * costs a single round trip however many SSNs exist.
 */
export function orgTree() {
  return query(`
    WITH RECURSIVE walk(id, depth, path) AS (
      SELECT id, 0, CAST(id AS TEXT) FROM org_units WHERE parent_id IS NULL
      UNION ALL
      SELECT u.id, w.depth + 1, w.path || '/' || u.id
        FROM org_units u JOIN walk w ON u.parent_id = w.id
    )
    SELECT o.*, w.depth, w.path
      FROM org_units o JOIN walk w ON w.id = o.id
     ORDER BY w.path COLLATE "C"
  `);
}

/** SSNs under a unit: itself if it is one, otherwise its descendants. */
export function ssnsUnder(unitId) {
  return query(`
    WITH RECURSIVE walk(id) AS (
      SELECT id FROM org_units WHERE id = $id
      UNION ALL
      SELECT u.id FROM org_units u JOIN walk w ON u.parent_id = w.id
    )
    SELECT o.* FROM org_units o JOIN walk w ON w.id = o.id
     WHERE o.kind = 'ssn'
     ORDER BY lower(o.name), o.name
  `, { id: Number(unitId) });
}

/* -------------------------------------------------------------- the split -- */

/**
 * Split an SSN's distributable amount into what it keeps and what goes up.
 *
 * `keep` is the truncated basis-point share and `upstream` is whatever is left,
 * so the two always reconcile to `distributable` exactly -- there is no
 * rounding mode under which a cent appears or disappears here.
 *
 * Assumption 7: a negative distributable is carried entirely by the SSN
 * and nothing travels upstream.
 */
export function splitDistributable(distributableCents, shareBps) {
  const distributable = Math.trunc(Number(distributableCents) || 0);
  if (distributable <= 0) return { keep_cents: distributable, upstream_cents: 0 };
  const { base } = applyBps(distributable, Math.trunc(Number(shareBps) || 0));
  return { keep_cents: base, upstream_cents: distributable - base };
}

/* ------------------------------------------------------------- a salary -- */

/**
 * One salary, resolved into the four figures that matter.
 *
 * Done per row rather than in aggregate SQL because every amount truncates on
 * its own: the hold on a salary is `credited x the job's rate`, truncated
 * there and then. Summing first and truncating once would leave the monthly
 * figure a cent away from the sum of the rows the statement lists underneath
 * it, and a statement whose lines do not add to its total is not a statement.
 */
export function resolveSalary(row) {
  const invoice = Math.trunc(Number(row.invoice_amount_cents) || 0);
  const credited = Math.trunc(Number(row.credited_amount_cents) || 0);
  // What the hiring company kept before crediting. Recorded, never deducted
  // again -- it never reached the SSN.
  const withheld = invoice - credited;
  const { base: hold } = applyBps(credited, Math.trunc(Number(row.tax_hold_bps) || 0));
  return {
    invoice_cents: invoice,
    credited_cents: credited,
    withheld_cents: withheld,
    tax_hold_cents: hold,
    to_ssn_cents: credited - hold,
  };
}

/** Every counted salary for an SSN in a month, with its job's terms attached. */
const salaryRowsFor = (ssnId, month) => query(
  `SELECT s.id, s.reference, s.accounting_month, s.invoice_amount_cents,
          s.credited_amount_cents, s.credit_date, s.status,
          s.pay_period_from, s.pay_period_to,
          j.id AS job_id, j.title AS job_title, j.client_name,
          j.tax_category, j.tax_hold_bps
     FROM salaries s
     JOIN jobs j ON j.id = s.job_id
    WHERE j.ssn_id = $ssn AND s.accounting_month = $month AND s.status = $status
    ORDER BY s.credit_date, s.id`,
  { ssn: ssnId, month, status: COUNTED_SALARY_STATUS }
);

/** The same rows with their derived figures, for a statement to list. */
export const salaryLinesFor = async (ssnId, month) =>
  (await salaryRowsFor(ssnId, month)).map((row) => ({ ...row, ...resolveSalary(row) }));

/* ----------------------------------------------------------- SSN month -- */

const expensesFor = async (ssnId, month) => Number((await queryOne(
  `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM expenses WHERE ssn_id = $ssn AND accounting_month = $month AND status = $status`,
  { ssn: ssnId, month, status: COUNTED_EXPENSE_STATUS }
)).total);

const overrideFor = (ssnId, month) => queryOne(
  `SELECT * FROM tax_overrides WHERE ssn_id = $ssn AND accounting_month = $month`,
  { ssn: ssnId, month }
);

/**
 * The full waterfall for one SSN in one month.
 *
 * This is the function the whole application is built on: the SSN statement
 * renders it, the sub-company roll-up sums its `upstream_cents`, and every
 * report derives from it. It reads inputs and computes; it writes nothing, so
 * it is safe to call for any month, past or future.
 *
 * The order is the order the money actually moves:
 *
 *   each salary:  credited  - the job's hold        = to the SSN
 *   the month:    sum of those  - the SSN's expenses = remaining
 *   the split:    the SSN keeps its share, the rest goes up
 *
 * The tax hold therefore comes off BEFORE expenses here, which is a change
 * from taxing net: tax is owed on what was earned, not on what is left after
 * the SSN's own costs.
 */
export async function ssnMonth(ssnInput, monthInput) {
  const ssn = typeof ssnInput === 'object' ? ssnInput : await unitById(ssnInput);
  const month = toMonth(monthInput);
  if (!ssn || ssn.kind !== 'ssn') throw new Error('ssnMonth requires an SSN');
  if (!month) throw new Error('ssnMonth requires an accounting month');

  const lines = await salaryLinesFor(ssn.id, month);

  const invoice_cents = sum(lines.map((l) => l.invoice_cents));
  const credited_cents = sum(lines.map((l) => l.credited_cents));
  const withheld_cents = sum(lines.map((l) => l.withheld_cents));
  const computed_tax_cents = sum(lines.map((l) => l.tax_hold_cents));

  const override = await overrideFor(ssn.id, month);
  /*
   * The hold is clamped to what was credited: it can never exceed the money it
   * is held out of. An override replaces the computed total but is clamped the
   * same way, so a mistyped override cannot invent a negative salary.
   */
  const tax_hold_cents = override
    ? Math.min(credited_cents, Math.max(0, Math.trunc(override.amount_cents)))
    : computed_tax_cents;
  const tax_basis = override ? 'override' : (credited_cents === 0 ? 'none' : 'per_job');

  const salary_cents = credited_cents - tax_hold_cents;
  const expense_cents = await expensesFor(ssn.id, month);
  const distributable_cents = salary_cents - expense_cents;
  const { keep_cents, upstream_cents } = splitDistributable(distributable_cents, ssn.share_bps);

  return {
    ssn_id: ssn.id,
    ssn_name: ssn.name,
    parent_id: ssn.parent_id,
    accounting_month: month,
    salary_count: lines.length,
    job_count: new Set(lines.map((l) => l.job_id)).size,
    invoice_cents,
    credited_cents,
    withheld_cents,
    tax_hold_cents,
    tax_basis,
    computed_tax_cents,
    tax_override_reason: override?.reason ?? null,
    // What reached the SSN from its salaries, after the holds.
    salary_cents,
    expense_cents,
    distributable_cents,
    share_bps: ssn.share_bps,
    keep_cents,
    upstream_cents,
  };
}

/* ------------------------------------------------------ sub-company month -- */

/**
 * What a sub-company collected in a month.
 *
 * Assumption 8: it keeps nothing, so `passed_up_cents` always equals
 * `collected_cents`. The field is not redundant -- it is the line the main
 * company's total is built from, and naming it makes the roll-up readable and
 * leaves one obvious place to change if a sub-company ever earns a cut.
 */
export async function subMonth(subInput, monthInput) {
  const sub = typeof subInput === 'object' ? subInput : await unitById(subInput);
  const month = toMonth(monthInput);
  if (!sub || sub.kind !== 'sub') throw new Error('subMonth requires a sub-company');

  const ssns = await mapSeries(
    (await childrenOf(sub.id)).filter((d) => d.kind === 'ssn' && d.is_active),
    (d) => ssnMonth(d, month)
  );

  const collected_cents = sum(ssns.map((d) => d.upstream_cents));

  return {
    unit_id: sub.id,
    unit_name: sub.name,
    accounting_month: month,
    ssn_count: ssns.length,
    ssns: ssns,
    invoice_cents: sum(ssns.map((d) => d.invoice_cents)),
    credited_cents: sum(ssns.map((d) => d.credited_cents)),
    withheld_cents: sum(ssns.map((d) => d.withheld_cents)),
    salary_cents: sum(ssns.map((d) => d.salary_cents)),
    expense_cents: sum(ssns.map((d) => d.expense_cents)),
    tax_hold_cents: sum(ssns.map((d) => d.tax_hold_cents)),
    distributable_cents: sum(ssns.map((d) => d.distributable_cents)),
    ssn_kept_cents: sum(ssns.map((d) => d.keep_cents)),
    collected_cents,
    kept_cents: 0,
    passed_up_cents: collected_cents,
  };
}

/* ------------------------------------------------------------- main month -- */

/**
 * What the main company received in a month, and the whole tree beneath it.
 *
 * `total_received_cents` is the number the business cares about: the sum of
 * what every sub-company passed up, which is the sum of what every SSN
 * sent upstream.
 */
export async function mainMonth(monthInput) {
  const month = toMonth(monthInput);
  const main = await mainUnit();
  if (!main) {
    return {
      unit_id: null, unit_name: null, accounting_month: month,
      sub_companies: [], ssn_count: 0,
      invoice_cents: 0, credited_cents: 0, withheld_cents: 0,
      salary_cents: 0, expense_cents: 0, tax_hold_cents: 0,
      distributable_cents: 0, ssn_kept_cents: 0, total_received_cents: 0,
    };
  }

  const subs = await mapSeries(
    (await childrenOf(main.id)).filter((u) => u.kind === 'sub' && u.is_active),
    (u) => subMonth(u, month)
  );

  return {
    unit_id: main.id,
    unit_name: main.name,
    accounting_month: month,
    sub_companies: subs,
    ssn_count: sum(subs.map((s) => s.ssn_count)),
    invoice_cents: sum(subs.map((s) => s.invoice_cents)),
    credited_cents: sum(subs.map((s) => s.credited_cents)),
    withheld_cents: sum(subs.map((s) => s.withheld_cents)),
    salary_cents: sum(subs.map((s) => s.salary_cents)),
    expense_cents: sum(subs.map((s) => s.expense_cents)),
    tax_hold_cents: sum(subs.map((s) => s.tax_hold_cents)),
    distributable_cents: sum(subs.map((s) => s.distributable_cents)),
    ssn_kept_cents: sum(subs.map((s) => s.ssn_kept_cents)),
    total_received_cents: sum(subs.map((s) => s.passed_up_cents)),
  };
}

/* ----------------------------------------------------------- time series -- */

/** The months that actually have activity, newest first. */
export async function activeMonths({ limit = 24 } = {}) {
  return (await query(`
    SELECT month FROM (
      SELECT DISTINCT accounting_month AS month FROM salaries WHERE status = $sal_status
      UNION
      SELECT DISTINCT accounting_month AS month FROM expenses WHERE status = $exp_status
    ) AS active ORDER BY month DESC LIMIT $limit
  `, { sal_status: COUNTED_SALARY_STATUS, exp_status: COUNTED_EXPENSE_STATUS, limit }
  )).map((r) => r.month);
}

/** mainMonth across a list of months, oldest first, for charts and trends. */
export function monthlyTrend(months) {
  return mapSeries([...months].sort(), async (month) => {
    const roll = await mainMonth(month);
    return {
      month,
      invoice_cents: roll.invoice_cents,
      credited_cents: roll.credited_cents,
      withheld_cents: roll.withheld_cents,
      salary_cents: roll.salary_cents,
      expense_cents: roll.expense_cents,
      tax_hold_cents: roll.tax_hold_cents,
      ssn_kept_cents: roll.ssn_kept_cents,
      received_cents: roll.total_received_cents,
    };
  });
}

/**
 * Every SSN's month in one pass, flattened.
 *
 * Used by the dashboard table, reports and exports, so they all agree with the
 * SSN statement by construction rather than by coincidence.
 */
export async function allSsnMonths(month) {
  const resolved = toMonth(month);
  const ssns = await query(`
    SELECT d.*, s.name AS sub_name, s.id AS sub_id
      FROM org_units d
      JOIN org_units s ON s.id = d.parent_id
     WHERE d.kind = 'ssn' AND d.is_active = 1
     ORDER BY lower(s.name), s.name, lower(d.name), d.name
  `);
  return mapSeries(ssns, async (ssn) => ({
    ...(await ssnMonth(ssn, resolved)), sub_name: ssn.sub_name, sub_id: ssn.sub_id,
  }));
}

/* ------------------------------------------------------- ranges and filters -- */

/*
 * Figures that add up across months. Everything else on an ssnMonth is either
 * a rate, a basis or a name, and summing those would be nonsense -- which is
 * why this list is explicit rather than "every numeric key".
 */
const SUMMABLE = [
  'invoice_cents', 'credited_cents', 'withheld_cents',
  'tax_hold_cents', 'computed_tax_cents',
  'salary_cents', 'expense_cents', 'distributable_cents',
  'keep_cents', 'upstream_cents', 'salary_count',
];

/** How many months a range may cover before it is refused. */
export const MAX_RANGE_MONTHS = 60;

/**
 * The months a filter covers, oldest first.
 *
 * Capped, so a mistyped year cannot ask the engine for a thousand statements.
 * An inverted range is empty rather than an error: the caller decides whether
 * that is worth complaining about.
 */
export function monthsCovered(from, to) {
  return monthRange(from, to).slice(0, MAX_RANGE_MONTHS);
}

/**
 * Distinct jobs that paid into a range, per SSN.
 *
 * Summing each month's job_count would count a job once per month it paid --
 * a retainer running all year would read as twelve jobs. One grouped query
 * answers it properly for every SSN at once.
 */
async function distinctJobsBySsn(months) {
  if (!months.length) return new Map();
  const keys = Object.fromEntries(months.map((m, i) => [`m${i}`, m]));
  const placeholders = months.map((_, i) => `$m${i}`).join(',');
  const rows = await query(`
    SELECT j.ssn_id, COUNT(DISTINCT j.id) AS n
      FROM salaries s
      JOIN jobs j ON j.id = s.job_id
     WHERE s.status = $status AND s.accounting_month IN (${placeholders})
     GROUP BY j.ssn_id
  `, { ...keys, status: COUNTED_SALARY_STATUS });
  return new Map(rows.map((r) => [Number(r.ssn_id), Number(r.n)]));
}

/**
 * One SSN's months added together.
 *
 * `share_bps` comes from the SSN as it stands now, not from any month: it is
 * standing policy rather than a figure, so there is nothing to sum. Where a
 * month's hold was overridden, `override_months` says how many -- a single
 * `tax_basis` cannot describe a range honestly.
 */
export async function ssnRange(ssnInput, months) {
  const ssn = typeof ssnInput === 'object' ? ssnInput : await unitById(ssnInput);
  const rows = await mapSeries(months, (month) => ssnMonth(ssn, month));

  const totals = {};
  for (const key of SUMMABLE) totals[key] = sum(rows.map((r) => r[key]));

  return {
    ssn_id: ssn.id,
    ssn_name: ssn.name,
    parent_id: ssn.parent_id,
    share_bps: ssn.share_bps,
    months: months.length,
    month_from: months[0] ?? null,
    month_to: months[months.length - 1] ?? null,
    override_months: rows.filter((r) => r.tax_basis === 'override').length,
    ...totals,
    // Per-month detail, so a caller can chart the range it just asked for.
    by_month: rows.map((r) => ({
      month: r.accounting_month,
      ...Object.fromEntries(SUMMABLE.map((k) => [k, r[k]])),
    })),
  };
}

const aggregate = (rows) => Object.fromEntries(
  SUMMABLE.map((key) => [key, sum(rows.map((r) => r[key]))])
);

/**
 * THE dashboard answer: a month range, narrowed by sub-company, by SSN, and by
 * what the viewer is allowed to see.
 *
 * All three narrowings happen in one place. The route used to re-sum the tree
 * by hand to apply a user's scope, which meant the scoped totals and the
 * unscoped ones were computed by different code -- the exact situation this
 * module exists to prevent.
 */
export async function rangeSummary({ months, subId = null, ssnId = null, allowed = null } = {}) {
  const main = await mainUnit();

  const ssns = (await query(`
    SELECT d.*, s.name AS sub_name, s.id AS sub_id
      FROM org_units d
      JOIN org_units s ON s.id = d.parent_id
     WHERE d.kind = 'ssn' AND d.is_active = 1
     ORDER BY lower(s.name), s.name, lower(d.name), d.name
  `)).filter((ssn) => (allowed === null || allowed.includes(ssn.id))
    && (subId === null || Number(ssn.sub_id) === Number(subId))
    && (ssnId === null || Number(ssn.id) === Number(ssnId)));

  const jobCounts = await distinctJobsBySsn(months);

  const ssnRows = await mapSeries(ssns, async (ssn) => ({
    ...(await ssnRange(ssn, months)),
    sub_name: ssn.sub_name,
    sub_id: ssn.sub_id,
    job_count: jobCounts.get(ssn.id) ?? 0,
  }));

  // Grouped into sub-companies, which keep nothing: what one passes up is
  // exactly what its SSNs sent.
  const bySub = new Map();
  for (const row of ssnRows) {
    if (!bySub.has(row.sub_id)) bySub.set(row.sub_id, { unit_id: row.sub_id, unit_name: row.sub_name, ssns: [] });
    bySub.get(row.sub_id).ssns.push(row);
  }
  const subs = [...bySub.values()].map((sub) => ({
    ...sub,
    ssn_count: sub.ssns.length,
    job_count: sum(sub.ssns.map((r) => r.job_count)),
    ...aggregate(sub.ssns),
    ssn_kept_cents: sum(sub.ssns.map((r) => r.keep_cents)),
    collected_cents: sum(sub.ssns.map((r) => r.upstream_cents)),
    kept_cents: 0,
    passed_up_cents: sum(sub.ssns.map((r) => r.upstream_cents)),
  }));

  const rollup = {
    unit_id: main?.id ?? null,
    unit_name: main?.name ?? null,
    months: months.length,
    month_from: months[0] ?? null,
    month_to: months[months.length - 1] ?? null,
    sub_companies: subs,
    ssn_count: ssnRows.length,
    job_count: sum(ssnRows.map((r) => r.job_count)),
    ...aggregate(ssnRows),
    ssn_kept_cents: sum(ssnRows.map((r) => r.keep_cents)),
    total_received_cents: sum(ssnRows.map((r) => r.upstream_cents)),
  };

  /*
   * A trend over exactly the filtered set, so the chart matches the cards
   * above it. Built from the per-SSN monthly detail already computed rather
   * than by walking the tree a second time.
   */
  const trend = months.map((month, index) => {
    const slice = ssnRows.map((r) => r.by_month[index]).filter(Boolean);
    return {
      month,
      ...aggregate(slice),
      received_cents: sum(ssnRows.map((r) => r.by_month[index]?.upstream_cents ?? 0)),
      ssn_kept_cents: sum(ssnRows.map((r) => r.by_month[index]?.keep_cents ?? 0)),
    };
  });

  return { rollup, ssns: ssnRows, trend };
}
