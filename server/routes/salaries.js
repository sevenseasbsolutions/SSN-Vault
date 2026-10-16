/**
 * Salaries: the money on a job, one record per accounting month.
 *
 * Two amounts are recorded and the rest is derived:
 *
 *   invoice    what was billed                           1,000.00
 *   credited   what actually arrived                       800.00
 *   ------------------------------------------------------------
 *   withheld   invoice - credited, kept by the hiring       200.00
 *              company under W2. Recorded, never deducted
 *              from the SSN again -- it never arrived.
 *   tax hold   the JOB's hold % applied to credited          80.00  (at 10%)
 *   to the SSN credited - hold                              720.00
 *
 * Nothing derived is stored. The engine recomputes it from the job's current
 * terms, which is also why editing a job's hold restates the months it has
 * already paid into -- jobs.js says so on the response.
 */

import { Router } from 'express';
import { query, queryOne, execute } from '../db/connection.js';
import { handler, pagination, sorting, paged, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, validationError, badRequest } from '../lib/errors.js';
import { nowIso, toMonth } from '../lib/dates.js';
import { audit, diff } from '../lib/audit.js';
import { applyBps } from '../lib/money.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { assertDeletionAllowed } from '../lib/deletion.js';
import { insertWithReference } from '../lib/reference.js';
import { applyScope } from '../auth/permissions.js';
import { resolveSalary } from '../services/rollup.js';

const router = Router();
router.use(requireAuth);

const SORTABLE = {
  accounting_month: 'sa.accounting_month',
  credit_date: 'sa.credit_date',
  pay_period: 'sa.pay_period_from',
  invoice: 'sa.invoice_amount_cents',
  credited: 'sa.credited_amount_cents',
  job: 'j.title',
  ssn: 'd.name',
  status: 'sa.status',
  created_at: 'sa.created_at',
};

const SELECT = `
  SELECT sa.*, j.title AS job_title, j.client_name, j.tax_category, j.tax_hold_bps,
         j.reference AS job_reference,
         d.id AS ssn_id, d.name AS ssn_name, s.id AS sub_id, s.name AS sub_name,
         cu.name AS created_by_name, uu.name AS updated_by_name
    FROM salaries sa
    JOIN jobs j ON j.id = sa.job_id
    JOIN org_units d ON d.id = j.ssn_id
    JOIN org_units s ON s.id = d.parent_id
    LEFT JOIN users cu ON cu.id = sa.created_by
    LEFT JOIN users uu ON uu.id = sa.updated_by
`;

const JOINS = `FROM salaries sa
    JOIN jobs j ON j.id = sa.job_id
    JOIN org_units d ON d.id = j.ssn_id
    JOIN org_units s ON s.id = d.parent_id`;

/** Attach the derived figures, from the one place that knows how. */
const present = (row) => ({ ...row, ...resolveSalary(row) });

function buildFilters(req) {
  const clauses = [];
  const params = {};
  const f = req.query;

  if (!applyScope(req.actor, 'org_unit', 'j.ssn_id', clauses, params, 'scope')) {
    return { clauses, params, empty: true };
  }

  if (f.job_id) { clauses.push('sa.job_id = $f_job'); params.f_job = Number(f.job_id); }
  if (f.ssn_id) { clauses.push('j.ssn_id = $f_ssn'); params.f_ssn = Number(f.ssn_id); }
  if (f.sub_id) { clauses.push('s.id = $f_sub'); params.f_sub = Number(f.sub_id); }
  if (f.tax_category) { clauses.push('j.tax_category = $f_cat'); params.f_cat = String(f.tax_category); }
  if (f.status) { clauses.push('sa.status = $f_status'); params.f_status = String(f.status); }
  if (f.month_from) { clauses.push('sa.accounting_month >= $f_mf'); params.f_mf = toMonth(f.month_from); }
  if (f.month_to) { clauses.push('sa.accounting_month <= $f_mt'); params.f_mt = toMonth(f.month_to); }
  if (f.credit_from) { clauses.push('sa.credit_date >= $f_cf'); params.f_cf = String(f.credit_from).slice(0, 10); }
  if (f.credit_to) { clauses.push('sa.credit_date <= $f_ct'); params.f_ct = String(f.credit_to).slice(0, 10); }
  /*
   * Pay periods that OVERLAP the range, not ones contained by it: a period
   * running 21 Sep to 5 Oct belongs in an October search, and a containment
   * test would hide it.
   */
  if (f.period_from) {
    clauses.push('(sa.pay_period_to IS NULL OR sa.pay_period_to >= $f_pf)');
    params.f_pf = String(f.period_from).slice(0, 10);
  }
  if (f.period_to) {
    clauses.push('(sa.pay_period_from IS NULL OR sa.pay_period_from <= $f_pt)');
    params.f_pt = String(f.period_to).slice(0, 10);
  }
  if (f.amount_min) { clauses.push('sa.credited_amount_cents >= $f_amin'); params.f_amin = Number(f.amount_min); }
  if (f.amount_max) { clauses.push('sa.credited_amount_cents <= $f_amax'); params.f_amax = Number(f.amount_max); }
  // Only the rows where the hiring company actually kept something.
  if (f.withheld === 'true') clauses.push('sa.invoice_amount_cents > sa.credited_amount_cents');
  if (f.search) {
    clauses.push('(j.title ILIKE $f_q OR j.client_name ILIKE $f_q OR sa.reference ILIKE $f_q'
      + ' OR j.reference ILIKE $f_q)');
    params.f_q = `%${String(f.search).replace(/[%_]/g, '')}%`;
  }
  return { clauses, params, empty: false };
}

const whereSql = (clauses) => (clauses.length ? `WHERE ${clauses.join(' AND ')}` : '');

const EMPTY_TOTALS = {
  count: 0, invoice_cents: 0, credited_cents: 0, withheld_cents: 0,
  tax_hold_cents: 0, to_ssn_cents: 0,
};

router.get('/', requirePermission('salaries.view'), handler(async (req, res) => {
  const { clauses, params, empty } = buildFilters(req);
  const page = pagination(req);
  const sort = sorting(req, SORTABLE, 'accounting_month');

  if (empty) {
    return noStore(res).json({ ...paged([], 0, page), sort, totals: EMPTY_TOTALS });
  }

  const where = whereSql(clauses);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n ${JOINS} ${where}`, params)).n);
  const rows = (await query(
    `${SELECT} ${where} ORDER BY ${sort.sql}, sa.id DESC LIMIT $limit OFFSET $offset`,
    { ...params, limit: page.limit, offset: page.offset }
  )).map(present);

  /*
   * Totals cover the whole filtered set, not just this page. Each row's hold
   * is truncated on its own before summing -- the same rule the engine uses --
   * so this figure always equals the sum of the per-row amounts.
   */
  const counted = (await query(
    `SELECT sa.invoice_amount_cents, sa.credited_amount_cents, j.tax_hold_bps
       ${JOINS} ${where ? `${where} AND` : 'WHERE'} sa.status = 'active'`, params
  )).map(resolveSalary);

  const totals = counted.reduce((acc, line) => ({
    count: acc.count + 1,
    invoice_cents: acc.invoice_cents + line.invoice_cents,
    credited_cents: acc.credited_cents + line.credited_cents,
    withheld_cents: acc.withheld_cents + line.withheld_cents,
    tax_hold_cents: acc.tax_hold_cents + line.tax_hold_cents,
    to_ssn_cents: acc.to_ssn_cents + line.to_ssn_cents,
  }), { ...EMPTY_TOTALS });

  noStore(res).json({ ...paged(rows, total, page), sort, totals });
}));

router.get('/:id', requirePermission('salaries.view'), handler(async (req, res) => {
  const row = await queryOne(`${SELECT} WHERE sa.id = $id`, { id: Number(req.params.id) });
  if (!row) throw notFound('Salary not found');
  if (!req.actor.allowsScope('org_unit', row.ssn_id)) throw notFound('Salary not found');
  res.json({ salary: present(row) });
}));

/* ----------------------------------------------------------------- writes -- */

function validateSalary(req, { partial = false } = {}) {
  const required = !partial;
  return check(req.body)
    .int('job_id', { required, min: 1, label: 'Job' })
    .month('accounting_month', { required, label: 'Accounting month' })
    .amount('invoice_amount', { required, min: 0, label: 'Invoice amount' })
    .amount('credited_amount', { required, min: 0, label: 'Amount credited' })
    .date('credit_date', { label: 'Credit date' })
    .date('pay_period_from', { label: 'Pay period from' })
    .date('pay_period_to', { label: 'Pay period to' })
    .enum('status', ['draft', 'active', 'void'], { label: 'Status' })
    .string('notes', { max: 2000, label: 'Notes' })
    .int('attachment_id', { min: 1, label: 'Attachment' })
    .result();
}

/** The job must exist, be in scope, and still be open to new salaries. */
async function assertJob(req, jobId, { existing = false } = {}) {
  const job = await queryOne(
    `SELECT j.*, d.name AS ssn_name FROM jobs j
       JOIN org_units d ON d.id = j.ssn_id WHERE j.id = $id`,
    { id: jobId }
  );
  if (!job) throw validationError({ job_id: 'Choose a job' });
  if (!req.actor.allowsScope('org_unit', job.ssn_id)) {
    throw validationError({ job_id: 'You are not authorised to record against this job' });
  }
  // An inactive job keeps its history but takes nothing new.
  if (!existing && !job.is_active) {
    throw validationError({
      job_id: `${job.title} is marked inactive. Reactivate it to record a new salary.`,
    });
  }
  return job;
}

/**
 * A pay period must not end before it starts.
 *
 * Either date alone is allowed -- an open-ended period is a real thing -- so
 * the two are only compared when both are present. The database has a trigger
 * saying the same, but this is where a user gets a readable message.
 */
function assertPeriod(from, to) {
  if (from && to && to < from) {
    throw validationError({
      pay_period_to: 'The pay period cannot end before it starts',
    });
  }
}

/** Credited can never exceed invoiced, or the withheld amount goes negative. */
function assertAmounts(invoice, credited) {
  if (credited > invoice) {
    throw validationError({
      credited_amount: 'More cannot be credited than was invoiced. '
        + 'The difference is what the company deducted.',
    });
  }
}

router.post('/', requirePermission('salaries.create'), handler(async (req, res) => {
  const data = validateSalary(req);
  const job = await assertJob(req, data.job_id);
  assertAmounts(data.invoice_amount_cents, data.credited_amount_cents);
  assertPeriod(data.pay_period_from, data.pay_period_to);
  const now = nowIso();

  const id = await insertWithReference('salaries', 'SAL', data.accounting_month, async (reference) => {
    const result = await execute(
      `INSERT INTO salaries
         (reference, job_id, accounting_month, invoice_amount_cents, credited_amount_cents,
          credit_date, pay_period_from, pay_period_to, status, notes, attachment_id,
          created_by, created_at, updated_by, updated_at)
       VALUES ($reference, $job_id, $accounting_month, $invoice, $credited,
               $credit_date, $period_from, $period_to, $status, $notes, $attachment_id,
               $actor, $now, $actor, $now)
       RETURNING id`,
      {
        reference,
        job_id: data.job_id,
        accounting_month: data.accounting_month,
        invoice: data.invoice_amount_cents,
        credited: data.credited_amount_cents,
        credit_date: data.credit_date ?? null,
        period_from: data.pay_period_from ?? null,
        period_to: data.pay_period_to ?? null,
        status: data.status ?? 'active',
        notes: data.notes ?? null,
        attachment_id: data.attachment_id ?? null,
        actor: req.user.id,
        now,
      }
    );
    return Number(result.lastInsertRowid);
  });

  const { base: hold } = applyBps(data.credited_amount_cents, job.tax_hold_bps);

  await audit(req, 'salary', id, 'created', {
    job_id: { from: null, to: data.job_id },
    accounting_month: { from: null, to: data.accounting_month },
    invoice_amount_cents: { from: null, to: data.invoice_amount_cents },
    credited_amount_cents: { from: null, to: data.credited_amount_cents },
  });

  res.status(201).json({
    salary: present(await queryOne(`${SELECT} WHERE sa.id = $id`, { id })),
    // What this salary did, spelled out, so the caller need not recompute it.
    effect: {
      withheld_cents: data.invoice_amount_cents - data.credited_amount_cents,
      tax_hold_cents: hold,
      to_ssn_cents: data.credited_amount_cents - hold,
      ssn_name: job.ssn_name,
    },
  });
}));

const TRACKED = [
  'job_id', 'accounting_month', 'invoice_amount_cents', 'credited_amount_cents',
  'credit_date', 'pay_period_from', 'pay_period_to', 'status', 'notes', 'attachment_id',
];

router.put('/:id', requirePermission('salaries.edit'), handler(async (req, res) => {
  const existing = await queryOne('SELECT * FROM salaries WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Salary not found');
  await assertJob(req, existing.job_id, { existing: true });

  const data = validateSalary(req, { partial: true });
  if (data.job_id && data.job_id !== existing.job_id) await assertJob(req, data.job_id);

  const next = {
    job_id: data.job_id ?? existing.job_id,
    accounting_month: data.accounting_month ?? existing.accounting_month,
    invoice_amount_cents: data.invoice_amount_cents ?? existing.invoice_amount_cents,
    credited_amount_cents: data.credited_amount_cents ?? existing.credited_amount_cents,
    credit_date: data.credit_date ?? existing.credit_date,
    pay_period_from: data.pay_period_from ?? existing.pay_period_from,
    pay_period_to: data.pay_period_to ?? existing.pay_period_to,
    status: data.status ?? existing.status,
    notes: data.notes ?? existing.notes,
    attachment_id: data.attachment_id ?? existing.attachment_id,
  };
  assertAmounts(next.invoice_amount_cents, next.credited_amount_cents);
  assertPeriod(next.pay_period_from, next.pay_period_to);

  await execute(
    `UPDATE salaries
        SET job_id = $job_id, accounting_month = $accounting_month,
            invoice_amount_cents = $invoice_amount_cents,
            credited_amount_cents = $credited_amount_cents,
            credit_date = $credit_date, pay_period_from = $pay_period_from,
            pay_period_to = $pay_period_to, status = $status, notes = $notes,
            attachment_id = $attachment_id, updated_by = $actor, updated_at = $now
      WHERE id = $id`,
    { ...next, id: existing.id, actor: req.user.id, now: nowIso() }
  );

  const changes = diff(existing, next, TRACKED);
  if (Object.keys(changes).length) await audit(req, 'salary', existing.id, 'updated', changes);

  res.json({ salary: present(await queryOne(`${SELECT} WHERE sa.id = $id`, { id: existing.id })) });
}));

router.delete('/:id', requirePermission('salaries.delete'), handler(async (req, res) => {
  await assertDeletionAllowed();
  const existing = await queryOne('SELECT * FROM salaries WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Salary not found');
  await assertJob(req, existing.job_id, { existing: true });

  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) throw badRequest('A reason is required to delete a salary');

  await execute('DELETE FROM salaries WHERE id = $id', { id: existing.id });

  await audit(req, 'salary', existing.id, 'deleted', {
    reference: { from: existing.reference, to: null },
    credited_amount_cents: { from: existing.credited_amount_cents, to: null },
    accounting_month: { from: existing.accounting_month, to: null },
  }, reason);

  res.json({ deleted: true });
}));

export default router;
