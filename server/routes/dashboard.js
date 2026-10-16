/**
 * The dashboard: a month range, the whole tree, narrowed however you like.
 *
 * Everything here comes out of services/rollup.js, so the headline figure, the
 * per-sub-company breakdown and each SSN's row are the same numbers the SSN
 * statement shows -- they cannot drift apart. The narrowing happens there too,
 * for the same reason: a filtered total and an unfiltered one must not be
 * computed by two different pieces of code.
 *
 * Filters, all optional:
 *   month                  one accounting month
 *   date_from, date_to     a span of dates, answered in whole months
 *   sub_id                 one sub-company
 *   ssn_id                 one SSN
 *
 * A month and a date span cannot be combined -- see services/range.js, which
 * decides this for every page that takes a range.
 *
 * With nothing given it answers for the newest month that has any activity,
 * which is what it did before any of these existed.
 */

import { Router } from 'express';
import { query } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { validationError } from '../lib/errors.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import {
  activeMonths, mainUnit, rangeSummary, monthsCovered, MAX_RANGE_MONTHS, unitById,
} from '../services/rollup.js';
import { resolveRange } from '../services/range.js';

const router = Router();
router.use(requireAuth);

/** A filter naming a unit must name one that exists, of the right kind, in scope. */
async function resolveUnit(req, param, kind) {
  const raw = req.query[param];
  if (!raw) return null;
  const unit = await unitById(raw);
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

router.get('/', requirePermission('dashboard.view'), handler(async (req, res) => {
  const main = await mainUnit();
  const range = await resolveRange(req);
  const { from, to } = range;

  if (from > to) {
    throw validationError({ month_from: 'The start month is after the end month' });
  }

  const months = monthsCovered(from, to);
  if (!months.length) {
    throw validationError({ month_from: 'That range covers no months' });
  }

  const sub = await resolveUnit(req, 'sub_id', 'sub');
  const ssn = await resolveUnit(req, 'ssn_id', 'ssn');

  const { rollup, ssns, trend } = await rangeSummary({
    months,
    subId: sub?.id ?? null,
    ssnId: ssn?.id ?? null,
    allowed: req.actor.scope('org_unit'),
  });

  /*
   * Expenses grouped by category, over exactly the same SSNs and months.
   *
   * Everything else the page can break down -- income, tax, shares -- is
   * already per-SSN in `ssns`. Category is the one axis the engine does not
   * carry, and it is the breakdown a reader actually wants when they ask what
   * the expenses were, so it is fetched here rather than left to the client.
   */
  const expenseCategories = await (async () => {
    const ids = ssns.map((r) => r.ssn_id);
    if (!ids.length || !months.length) return [];
    const params = { status: 'approved' };
    ids.forEach((id, i) => { params[`s${i}`] = id; });
    months.forEach((m, i) => { params[`m${i}`] = m; });
    return (await query(`
      SELECT c.id AS category_id, c.name,
             COALESCE(SUM(e.amount_cents), 0) AS amount_cents,
             COUNT(*) AS count
        FROM expenses e
        JOIN expense_categories c ON c.id = e.category_id
       WHERE e.status = $status
         AND e.ssn_id IN (${ids.map((_, i) => `$s${i}`).join(',')})
         AND e.accounting_month IN (${months.map((_, i) => `$m${i}`).join(',')})
       GROUP BY c.id
       ORDER BY amount_cents DESC, c.id
    `, params)).map((r) => ({
      category_id: Number(r.category_id),
      name: r.name,
      amount_cents: Number(r.amount_cents),
      count: Number(r.count),
    }));
  })();

  noStore(res).json({
    /*
     * Echoed back so the page shows what it is actually displaying rather than
     * what was typed. The two differ whenever an end was left open or the
     * range was longer than the cap.
     */
    range: {
      from,
      to,
      months: months.length,
      /*
       * How the range was asked for, and with what. A date span resolves to
       * whole months, so the page needs the dates back to be able to say that
       * is what it did.
       */
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
    },
    months: await activeMonths(),
    main: main ? { id: main.id, name: main.name } : null,
    rollup,
    ssns,
    expense_categories: expenseCategories,
    trend,
    setup_needed: !main,
  });
}));

export default router;
