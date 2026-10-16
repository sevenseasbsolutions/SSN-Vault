/**
 * Reports.
 *
 * Three questions, three reports:
 *   month      what every SSN did in one month, and what reached MBS
 *   SSN one SSN across a range of months
 *   rollup     the tree for one month, as MBS sees it
 *
 * Each is also exportable. The export is rendered from the SAME rows the JSON
 * response carries, so a spreadsheet and the screen can never disagree.
 */

import { Router } from 'express';
import { query } from '../db/connection.js';
import { handler, noStore, attachmentHeaders } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, validationError } from '../lib/errors.js';
import { toMonth, addMonths, currentMonth, monthKey } from '../lib/dates.js';
import { sum } from '../lib/money.js';
import { mapSeries } from '../lib/async.js';
import { toCsv, toXlsx } from '../lib/export.js';
import { listAudit } from '../lib/audit.js';
import { statementPdf } from '../lib/pdf.js';
import { loadSettings } from '../services/settings.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import {
  mainMonth, allSsnMonths, activeMonths, unitById, ssnMonth, ssnsUnder, mainUnit,
  salaryLinesFor,
} from '../services/rollup.js';

const router = Router();
router.use(requireAuth);

const MONTH_COLUMNS = [
  { key: 'sub_name', header: 'Sub-company' },
  { key: 'ssn_name', header: 'SSN' },
  { key: 'accounting_month', header: 'Month' },
  { key: 'job_count', header: 'Jobs', type: 'number' },
  { key: 'invoice_cents', header: 'Invoiced', type: 'money' },
  { key: 'credited_cents', header: 'Credited', type: 'money' },
  { key: 'withheld_cents', header: 'Deducted by company (W2)', type: 'money' },
  { key: 'salary_cents', header: 'To the SSN', type: 'money' },
  { key: 'expense_cents', header: 'Expenses', type: 'money' },
  { key: 'tax_hold_cents', header: 'Tax Hold', type: 'money' },
  { key: 'distributable_cents', header: 'Distributable', type: 'money' },
  { key: 'share_bps', header: 'SSN share %', type: 'percent' },
  { key: 'keep_cents', header: 'SSN share', type: 'money' },
  { key: 'upstream_cents', header: 'Passed upstream', type: 'money' },
];

const inScope = (actor) => {
  const allowed = actor.scope('org_unit');
  return (ssnId) => allowed === null || allowed.includes(ssnId);
};

const totalsOf = (rows) => ({
  job_count: sum(rows.map((r) => r.job_count)),
  invoice_cents: sum(rows.map((r) => r.invoice_cents)),
  credited_cents: sum(rows.map((r) => r.credited_cents)),
  withheld_cents: sum(rows.map((r) => r.withheld_cents)),
  salary_cents: sum(rows.map((r) => r.salary_cents)),
  expense_cents: sum(rows.map((r) => r.expense_cents)),
  tax_hold_cents: sum(rows.map((r) => r.tax_hold_cents)),
  distributable_cents: sum(rows.map((r) => r.distributable_cents)),
  keep_cents: sum(rows.map((r) => r.keep_cents)),
  upstream_cents: sum(rows.map((r) => r.upstream_cents)),
});

/* ------------------------------------------------------------ month report -- */

router.get('/month', requirePermission('reports.view'), handler(async (req, res) => {
  const month = toMonth(req.query.month) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
  const allow = inScope(req.actor);
  const rows = (await allSsnMonths(month)).filter((r) => allow(r.ssn_id));
  const main = await mainUnit();

  noStore(res).json({
    basis: {
      title: `SSN results for ${month}`,
      note: 'Accounting month. A job or expense counts in the month it was assigned to, '
        + 'not the month it is dated.',
    },
    month,
    months: await activeMonths(),
    main: main ? { id: main.id, name: main.name } : null,
    rows,
    totals: totalsOf(rows),
    received_by_main_cents: sum(rows.map((r) => r.upstream_cents)),
  });
}));

/* ------------------------------------------------------- SSN report -- */

/**
 * One SSN over a range of months.
 *
 * The range is inclusive and capped at 36 months so a mistyped year cannot ask
 * the engine for a thousand statements.
 */
router.get('/ssn/:id', requirePermission('reports.view'), handler(async (req, res) => {
  const ssn = await unitById(req.params.id);
  if (!ssn || ssn.kind !== 'ssn') throw notFound('SSN not found');
  if (!inScope(req.actor)(ssn.id)) throw notFound('SSN not found');

  const to = toMonth(req.query.month_to) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
  const from = toMonth(req.query.month_from) || addMonths(to, -5);
  if (from > to) throw validationError({ month_from: 'The start month is after the end month' });

  const months = [];
  for (let cursor = from; cursor <= to && months.length < 36; cursor = addMonths(cursor, 1)) {
    months.push(cursor);
  }

  const rows = await mapSeries(months, (month) => ssnMonth(ssn, month));
  const sub = ssn.parent_id ? await unitById(ssn.parent_id) : null;

  noStore(res).json({
    basis: {
      title: `${ssn.name} — ${from} to ${to}`,
      note: `Keeps ${(ssn.share_bps / 100).toFixed(2)}% of what remains; `
        + `the rest goes to ${sub?.name ?? 'its sub-company'}.`,
    },
    ssn: { ...ssn, sub_name: sub?.name ?? null },
    rows,
    totals: totalsOf(rows),
  });
}));

/* ----------------------------------------------------------- rollup report -- */

router.get('/rollup', requirePermission('reports.view'), handler(async (req, res) => {
  const month = toMonth(req.query.month) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
  const roll = await mainMonth(month);

  noStore(res).json({
    basis: {
      title: `Company roll-up for ${month}`,
      note: 'Each SSN keeps its share; every sub-company passes on everything it collects.',
    },
    month,
    months: await activeMonths(),
    rollup: roll,
  });
}));

/** Sub-company detail: its SSNs and what it collected. */
router.get('/sub/:id', requirePermission('reports.view'), handler(async (req, res) => {
  const unit = await unitById(req.params.id);
  if (!unit || unit.kind !== 'sub') throw notFound('Sub-company not found');
  const month = toMonth(req.query.month) || (await activeMonths({ limit: 1 }))[0] || currentMonth();

  const allow = inScope(req.actor);
  const rows = await mapSeries(
    (await ssnsUnder(unit.id)).filter((d) => allow(d.id)),
    (d) => ssnMonth(d, month)
  );

  noStore(res).json({
    basis: { title: `${unit.name} — ${month}`, note: 'A sub-company keeps nothing; it passes on what it collects.' },
    unit,
    month,
    rows,
    totals: totalsOf(rows),
    collected_cents: sum(rows.map((r) => r.upstream_cents)),
  });
}));

/* ----------------------------------------------------------------- export -- */

const FORMATS = ['csv', 'xlsx'];

router.get('/export/month', requirePermission('reports.export'), handler(async (req, res) => {
  const format = check(req.query).enum('format', FORMATS, { label: 'Format' }).result().format ?? 'csv';
  const month = toMonth(req.query.month) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
  const allow = inScope(req.actor);
  const rows = (await allSsnMonths(month)).filter((r) => allow(r.ssn_id));

  const meta = {
    title: `SSN results for ${month}`,
    basis: 'Accounting month',
    generated_at: new Date().toISOString(),
  };
  const filename = `ssns-${month}.${format}`;

  if (format === 'csv') {
    attachmentHeaders(res, filename, 'text/csv; charset=utf-8');
    return res.send(toCsv({ columns: MONTH_COLUMNS, rows, meta }));
  }
  attachmentHeaders(res, filename,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const buffer = await toXlsx({ columns: MONTH_COLUMNS, rows, meta, sheetName: 'SSNs' });
  return res.send(Buffer.from(buffer));
}));

router.get('/export/ssn/:id', requirePermission('reports.export'), handler(async (req, res) => {
  const ssn = await unitById(req.params.id);
  if (!ssn || ssn.kind !== 'ssn') throw notFound('SSN not found');
  if (!inScope(req.actor)(ssn.id)) throw notFound('SSN not found');

  const format = check(req.query).enum('format', FORMATS, { label: 'Format' }).result().format ?? 'csv';
  const to = toMonth(req.query.month_to) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
  const from = toMonth(req.query.month_from) || addMonths(to, -5);

  const months = [];
  for (let cursor = from; cursor <= to && months.length < 36; cursor = addMonths(cursor, 1)) {
    months.push(cursor);
  }
  const rows = await mapSeries(months, async (month) => ({ ...(await ssnMonth(ssn, month)), sub_name: null }));

  const meta = {
    title: `${ssn.name} — ${from} to ${to}`,
    basis: 'Accounting month',
    generated_at: new Date().toISOString(),
  };
  const filename = `${ssn.name.replace(/\W+/g, '-').toLowerCase()}-${from}-${to}.${format}`;

  if (format === 'csv') {
    attachmentHeaders(res, filename, 'text/csv; charset=utf-8');
    return res.send(toCsv({ columns: MONTH_COLUMNS, rows, meta }));
  }
  attachmentHeaders(res, filename,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const buffer = await toXlsx({ columns: MONTH_COLUMNS, rows, meta, sheetName: 'SSN' });
  return res.send(Buffer.from(buffer));
}));

/**
 * The audit history as a file.
 *
 * Capped at 10,000 rows: an export is for review and for handing to someone
 * else, and a file nobody can open is not an export. The filters narrow it.
 */
/** "amount_cents: 200000 -> 250000  ·  status: draft -> active" */
const describeChanges = (changes) => (changes
  ? Object.entries(changes)
    .map(([field, change]) => `${field}: ${change?.from ?? '-'} -> ${change?.to ?? '-'}`)
    .join('  ·  ')
  : '');

const AUDIT_COLUMNS = [
  { key: 'created_at', header: 'When' },
  { key: 'user_label', header: 'Who' },
  { key: 'entity_type', header: 'Record type' },
  { key: 'entity_id', header: 'Record' },
  { key: 'action', header: 'Action' },
  { key: 'reason', header: 'Reason' },
  { key: 'changes', header: 'Changes', value: (row) => describeChanges(row.changes) },
];

router.get('/audit-history', requirePermission('audit.view'), handler(async (req, res) => {
  const format = check(req.query).enum('format', FORMATS, { label: 'Format' }).result().format ?? 'csv';
  const { rows } = await listAudit({
    entityType: req.query.entity_type,
    entityId: req.query.entity_id,
    action: req.query.action,
    from: req.query.from,
    to: req.query.to,
    limit: 10000,
    offset: 0,
  });

  const meta = {
    title: 'Audit history',
    basis: 'Recorded time (UTC)',
    generated_at: new Date().toISOString(),
  };
  const filename = `audit-history.${format}`;

  if (format === 'csv') {
    attachmentHeaders(res, filename, 'text/csv; charset=utf-8');
    return res.send(toCsv({ columns: AUDIT_COLUMNS, rows, meta }));
  }
  attachmentHeaders(res, filename,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const buffer = await toXlsx({ columns: AUDIT_COLUMNS, rows, meta, sheetName: 'Audit' });
  return res.send(Buffer.from(buffer));
}));

/* --------------------------------------------------- one statement, as a PDF -- */

/**
 * An SSN's month as a PDF, laid out like the statement on screen.
 *
 * It reads from the same engine the screen does, so the two cannot disagree.
 * Gated on reports.export rather than reports.view: a file leaves the building
 * in a way a screen does not.
 */
router.get('/export/statement/:id', requirePermission('reports.export'),
  handler(async (req, res) => {
    const ssn = await unitById(req.params.id);
    if (!ssn || ssn.kind !== 'ssn') throw notFound('SSN not found');
    if (!inScope(req.actor)(ssn.id)) throw notFound('SSN not found');

    const month = toMonth(req.query.month) || (await activeMonths({ limit: 1 }))[0] || currentMonth();
    const statement = await ssnMonth(ssn, month);
    const sub = ssn.parent_id ? await unitById(ssn.parent_id) : null;
    const settings = await loadSettings();

    const buffer = await statementPdf({
      statement: { ...statement, sub_name: sub?.name ?? null },
      salaries: await salaryLinesFor(ssn.id, month),
      expenses: await query(
        `SELECT e.reference, e.expense_date, e.description, e.vendor, e.amount_cents,
                c.name AS category_name
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id
          WHERE e.ssn_id = $id AND e.accounting_month = $month AND e.status = 'approved'
          ORDER BY e.expense_date, e.id`,
        { id: ssn.id, month }
      ),
      settings,
      orgName: settings.org_name || 'Vault',
      generatedBy: req.user?.name ?? null,
    });

    // A filename that sorts and reads: alpha-2026-10-statement.pdf
    const slug = ssn.name.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    attachmentHeaders(res, `${slug}-${monthKey(month)}-statement.pdf`, 'application/pdf');
    return res.send(buffer);
  }));

export default router;
