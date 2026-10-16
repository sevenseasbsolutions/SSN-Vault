/**
 * Tax holds, and nothing else.
 *
 * The rate lives on each JOB: it is asked for when the job is set up and
 * applied to the credited amount of every salary recorded against it, so two
 * salaries in one month can be held at different rates. A month's hold is the
 * sum of those per-salary amounts.
 *
 * This page answers only tax questions -- what was held, what the salaries
 * came to, where an override changed it, and the effective rate that works out
 * to. Income figures beyond the amount the hold is taken FROM belong on the
 * dashboard; repeating them here would turn a tax page into a second, worse
 * dashboard.
 *
 * Also here: the exception. When the real tax figure for a month differs from
 * what the salaries come to, it is recorded as an override with a reason and
 * an author, rather than by quietly editing the salaries after the fact.
 *
 * Filters, all optional:
 *   month                  one accounting month
 *   date_from, date_to     a span of dates, answered in whole months
 *   sub_id                 one sub-company
 *   ssn_id                 one SSN
 *   basis                  'override' = only months an override changed
 *                          'per_job'  = only those left to the job rates
 *
 * The range filters are read by services/range.js, shared with the dashboard
 * so the same question put to either page covers the same months.
 */

import { Router } from 'express';
import { query, queryOne, execute } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, validationError } from '../lib/errors.js';
import { nowIso, toMonth } from '../lib/dates.js';
import { audit } from '../lib/audit.js';
import { sum } from '../lib/money.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { assertDeletionAllowed } from '../lib/deletion.js';
import {
  activeMonths, unitById, ssnMonth, rangeSummary, monthsCovered, MAX_RANGE_MONTHS,
} from '../services/rollup.js';
import { resolveRange } from '../services/range.js';

const router = Router();
router.use(requireAuth);

const BASES = ['override', 'per_job'];

/**
 * The effective rate actually held, in basis points.
 *
 * Not the job rates averaged: the hold divided by the money it came out of.
 * With an override in play, or several jobs at different rates, that is the
 * only figure that describes the month honestly. Undefined with nothing
 * credited -- a rate on zero is not zero, it is meaningless.
 */
const effectiveBps = (hold, credited) =>
  (credited > 0 ? Math.round((hold * 10000) / credited) : null);

function resolveUnit(req, param, kind) {
  const raw = req.query[param];
  if (!raw) return null;
  const unit = unitById(raw);
  if (!unit || unit.kind !== kind) {
    throw validationError({
      [param]: `No ${kind === 'sub' ? 'sub-company' : 'SSN'} with that id`,
    });
  }
  if (!req.actor.allowsScope('org_unit', unit.id)) {
    throw validationError({ [param]: 'You are not authorised to view that' });
  }
  return unit;
}

router.get('/', requirePermission('tax.view'), handler((req, res) => {
  const range = resolveRange(req);
  const { from, to } = range;
  if (from > to) {
    throw validationError({ month_from: 'The start month is after the end month' });
  }
  const months = monthsCovered(from, to);
  if (!months.length) throw validationError({ month_from: 'That range covers no months' });

  const basis = req.query.basis ? String(req.query.basis) : null;
  if (basis && !BASES.includes(basis)) {
    throw validationError({ basis: "Basis must be 'override' or 'per_job'" });
  }

  const sub = resolveUnit(req, 'sub_id', 'sub');
  const ssn = resolveUnit(req, 'ssn_id', 'ssn');

  // The same aggregation the dashboard uses, so the two cannot disagree about
  // what an SSN held in a month.
  const { ssns, trend } = rangeSummary({
    months,
    subId: sub?.id ?? null,
    ssnId: ssn?.id ?? null,
    allowed: req.actor.scope('org_unit'),
  });

  const rows = ssns
    .filter((r) => {
      if (basis === 'override') return r.override_months > 0;
      if (basis === 'per_job') return r.override_months === 0;
      return true;
    })
    .map((r) => ({
      ssn_id: r.ssn_id,
      ssn_name: r.ssn_name,
      sub_name: r.sub_name,
      months: r.months,
      month_from: r.month_from,
      month_to: r.month_to,
      // The amount the hold is taken from. Kept because a hold without its
      // base is a number nobody can check.
      credited_cents: r.credited_cents,
      // What the salaries' own rates come to, before any override.
      computed_tax_cents: r.computed_tax_cents,
      // What was actually held.
      tax_hold_cents: r.tax_hold_cents,
      override_months: r.override_months,
      override_delta_cents: r.tax_hold_cents - r.computed_tax_cents,
      effective_bps: effectiveBps(r.tax_hold_cents, r.credited_cents),
    }));

  const totals = {
    credited_cents: sum(rows.map((r) => r.credited_cents)),
    computed_tax_cents: sum(rows.map((r) => r.computed_tax_cents)),
    tax_hold_cents: sum(rows.map((r) => r.tax_hold_cents)),
    override_months: sum(rows.map((r) => r.override_months)),
    ssn_count: rows.length,
  };
  totals.override_delta_cents = totals.tax_hold_cents - totals.computed_tax_cents;
  totals.effective_bps = effectiveBps(totals.tax_hold_cents, totals.credited_cents);

  noStore(res).json({
    range: {
      from,
      to,
      months: months.length,
      // How it was asked for: a date span resolves to whole months, so the
      // page gets the dates back to be able to say so.
      basis: range.basis,
      date_from: range.date_from,
      date_to: range.date_to,
      truncated: months.length === MAX_RANGE_MONTHS,
      max_months: MAX_RANGE_MONTHS,
    },
    filters: {
      sub_id: sub?.id ?? null,
      sub_name: sub?.name ?? null,
      ssn_id: ssn?.id ?? null,
      ssn_name: ssn?.name ?? null,
      basis,
    },
    months: activeMonths(),
    rows,
    totals,
    // Tax only, month by month: what the salaries came to against what was
    // actually held, so a month an override moved stands out.
    trend: trend.map((t) => ({
      month: t.month,
      credited_cents: t.credited_cents,
      computed_tax_cents: t.computed_tax_cents,
      tax_hold_cents: t.tax_hold_cents,
    })),
  });
}));


/** The year's holds for one SSN, for an annual tax view. */
router.get('/ssn/:id', requirePermission('tax.view'), handler((req, res) => {
  const ssn = unitById(req.params.id);
  if (!ssn || ssn.kind !== 'ssn') throw notFound('SSN not found');
  if (!req.actor.allowsScope('org_unit', ssn.id)) throw notFound('SSN not found');

  const year = String(req.query.year ?? '').match(/^\d{4}$/)
    ? String(req.query.year)
    : String(new Date().getUTCFullYear());

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const rows = months.map((month) => ssnMonth(ssn, month));

  res.json({
    ssn,
    year,
    rows: rows.map((r) => ({
      accounting_month: r.accounting_month,
      credited_cents: r.credited_cents,
      withheld_cents: r.withheld_cents,
      tax_hold_cents: r.tax_hold_cents,
      tax_basis: r.tax_basis,
      tax_override_reason: r.tax_override_reason,
    })),
    total_held_cents: sum(rows.map((r) => r.tax_hold_cents)),
  });
}));

/* -------------------------------------------------------------- overrides -- */

router.get('/overrides', requirePermission('tax.view'), handler((req, res) => {
  const clauses = [];
  const params = {};
  if (req.query.ssn_id) { clauses.push('o.ssn_id = $ssn'); params.ssn = Number(req.query.ssn_id); }
  if (req.query.month) { clauses.push('o.accounting_month = $month'); params.month = toMonth(req.query.month); }

  const allowed = req.actor.scope('org_unit');
  if (allowed !== null) {
    if (allowed.length === 0) return res.json({ rows: [] });
    clauses.push(`o.ssn_id IN (${allowed.map((_, i) => `$s${i}`).join(',')})`);
    allowed.forEach((id, i) => { params[`s${i}`] = id; });
  }

  res.json({
    rows: query(`
      SELECT o.*, d.name AS ssn_name, u.name AS created_by_name
        FROM tax_overrides o
        JOIN org_units d ON d.id = o.ssn_id
        LEFT JOIN users u ON u.id = o.created_by
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY o.accounting_month DESC, d.name COLLATE NOCASE
    `, params),
  });
}));

/**
 * Set or replace the override for one SSN-month.
 *
 * Idempotent on (SSN, month): recording it twice corrects the figure
 * rather than stacking two holds, which is what a unique index on the pair
 * buys us.
 */
router.put('/overrides', requirePermission('tax.manage'), handler((req, res) => {
  const data = check(req.body)
    .int('ssn_id', { required: true, min: 1, label: 'SSN' })
    .month('accounting_month', { required: true, label: 'Accounting month' })
    .amount('amount', { required: true, min: 0, label: 'Tax hold' })
    .string('reason', { required: true, min: 3, max: 500, label: 'Reason' })
    .result();

  const ssn = unitById(data.ssn_id);
  if (!ssn || ssn.kind !== 'ssn') throw validationError({ ssn_id: 'Choose an SSN' });
  if (!req.actor.allowsScope('org_unit', ssn.id)) {
    throw validationError({ ssn_id: 'You are not authorised to change this SSN' });
  }

  const existing = queryOne(
    'SELECT * FROM tax_overrides WHERE ssn_id = $ssn AND accounting_month = $month',
    { ssn: ssn.id, month: data.accounting_month }
  );
  const now = nowIso();

  if (existing) {
    execute(
      `UPDATE tax_overrides
          SET amount_cents = $amount, reason = $reason, updated_by = $actor, updated_at = $now
        WHERE id = $id`,
      { id: existing.id, amount: data.amount_cents, reason: data.reason, actor: req.user.id, now }
    );
    audit(req, 'tax_override', existing.id, 'updated', {
      amount_cents: { from: existing.amount_cents, to: data.amount_cents },
      reason: { from: existing.reason, to: data.reason },
    });
  } else {
    const result = execute(
      `INSERT INTO tax_overrides
         (ssn_id, accounting_month, amount_cents, reason, created_by, created_at, updated_by, updated_at)
       VALUES ($ssn, $month, $amount, $reason, $actor, $now, $actor, $now)`,
      {
        ssn: ssn.id, month: data.accounting_month, amount: data.amount_cents,
        reason: data.reason, actor: req.user.id, now,
      }
    );
    audit(req, 'tax_override', Number(result.lastInsertRowid), 'created', {
      ssn_id: { from: null, to: ssn.id },
      accounting_month: { from: null, to: data.accounting_month },
      amount_cents: { from: null, to: data.amount_cents },
      reason: { from: null, to: data.reason },
    });
  }

  // Return the recomputed month, so the caller sees the effect and not just an ack.
  res.json({ statement: ssnMonth(ssn, data.accounting_month) });
}));

/** Remove an override, so the SSN's standing rate applies again. */
router.delete('/overrides/:id', requirePermission('tax.manage'), handler((req, res) => {
  assertDeletionAllowed();
  const existing = queryOne('SELECT * FROM tax_overrides WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Tax override not found');
  if (!req.actor.allowsScope('org_unit', existing.ssn_id)) throw notFound('Tax override not found');

  execute('DELETE FROM tax_overrides WHERE id = $id', { id: existing.id });
  audit(req, 'tax_override', existing.id, 'deleted', {
    amount_cents: { from: existing.amount_cents, to: null },
    accounting_month: { from: existing.accounting_month, to: null },
  });

  res.json({ deleted: true, statement: ssnMonth(existing.ssn_id, existing.accounting_month) });
}));

export default router;
