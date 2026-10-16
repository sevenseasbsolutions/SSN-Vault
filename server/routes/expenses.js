/**
 * Expenses: costs charged to an SSN.
 *
 * Each expense belongs to exactly one SSN, so it is deducted from that
 * SSN's revenue once and only once. The old allocation table -- which
 * split a cost across pools and partners and had to be checked to sum to the
 * expense exactly -- is gone, and with it the whole class of double-counting
 * bugs it existed to prevent.
 */

import { Router } from 'express';
import { query, queryOne, execute } from '../db/connection.js';
import { handler, pagination, sorting, paged, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, validationError, badRequest } from '../lib/errors.js';
import { nowIso, toMonth } from '../lib/dates.js';
import { audit, diff } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { assertDeletionAllowed } from '../lib/deletion.js';
import { insertWithReference } from '../lib/reference.js';
import { applyScope } from '../auth/permissions.js';
import { getSetting } from '../services/settings.js';

const router = Router();
router.use(requireAuth);

const SORTABLE = {
  accounting_month: 'e.accounting_month',
  expense_date: 'e.expense_date',
  amount: 'e.amount_cents',
  category: 'cat.name',
  ssn: 'd.name',
  vendor: 'e.vendor',
  status: 'e.status',
  created_at: 'e.created_at',
};

const SELECT = `
  SELECT e.*, cat.name AS category_name, d.name AS ssn_name,
         s.id AS sub_id, s.name AS sub_name,
         cu.name AS created_by_name, uu.name AS updated_by_name
    FROM expenses e
    JOIN expense_categories cat ON cat.id = e.category_id
    JOIN org_units d ON d.id = e.ssn_id
    JOIN org_units s ON s.id = d.parent_id
    LEFT JOIN users cu ON cu.id = e.created_by
    LEFT JOIN users uu ON uu.id = e.updated_by
`;

function buildFilters(req) {
  const clauses = [];
  const params = {};
  const f = req.query;

  if (!applyScope(req.actor, 'org_unit', 'e.ssn_id', clauses, params, 'scope')) {
    return { clauses, params, empty: true };
  }

  if (f.ssn_id) { clauses.push('e.ssn_id = $f_dept'); params.f_dept = Number(f.ssn_id); }
  if (f.sub_id) { clauses.push('s.id = $f_sub'); params.f_sub = Number(f.sub_id); }
  if (f.category_id) { clauses.push('e.category_id = $f_cat'); params.f_cat = Number(f.category_id); }
  if (f.status) { clauses.push('e.status = $f_status'); params.f_status = String(f.status); }
  if (f.month_from) { clauses.push('e.accounting_month >= $f_mf'); params.f_mf = toMonth(f.month_from); }
  if (f.month_to) { clauses.push('e.accounting_month <= $f_mt'); params.f_mt = toMonth(f.month_to); }
  if (f.date_from) { clauses.push('e.expense_date >= $f_df'); params.f_df = String(f.date_from).slice(0, 10); }
  if (f.date_to) { clauses.push('e.expense_date <= $f_dt'); params.f_dt = String(f.date_to).slice(0, 10); }
  if (f.amount_min) { clauses.push('e.amount_cents >= $f_amin'); params.f_amin = Number(f.amount_min); }
  if (f.amount_max) { clauses.push('e.amount_cents <= $f_amax'); params.f_amax = Number(f.amount_max); }
  if (f.search) {
    clauses.push('(e.description ILIKE $f_q OR e.vendor ILIKE $f_q OR e.reference ILIKE $f_q'
      + ' OR e.payment_reference ILIKE $f_q)');
    params.f_q = `%${String(f.search).replace(/[%_]/g, '')}%`;
  }
  return { clauses, params, empty: false };
}

const whereSql = (clauses) => (clauses.length ? `WHERE ${clauses.join(' AND ')}` : '');

router.get('/', requirePermission('expenses.view'), handler(async (req, res) => {
  const { clauses, params, empty } = buildFilters(req);
  const page = pagination(req);
  const sort = sorting(req, SORTABLE, 'expense_date');

  if (empty) {
    return noStore(res).json({
      ...paged([], 0, page), sort, totals: { amount_cents: 0, count: 0 },
    });
  }

  const where = whereSql(clauses);
  const joins = `FROM expenses e
    JOIN expense_categories cat ON cat.id = e.category_id
    JOIN org_units d ON d.id = e.ssn_id
    JOIN org_units s ON s.id = d.parent_id`;

  const total = Number((await queryOne(`SELECT COUNT(*) AS n ${joins} ${where}`, params)).n);
  const rows = await query(
    `${SELECT} ${where} ORDER BY ${sort.sql}, e.id DESC LIMIT $limit OFFSET $offset`,
    { ...params, limit: page.limit, offset: page.offset }
  );
  const totals = await queryOne(
    `SELECT COALESCE(SUM(e.amount_cents), 0) AS amount_cents, COUNT(*) AS count ${joins}
      ${where ? `${where} AND` : 'WHERE'} e.status = 'approved'`, params);

  noStore(res).json({
    ...paged(rows, total, page),
    sort,
    totals: { amount_cents: Number(totals.amount_cents), count: Number(totals.count) },
  });
}));

/* ------------------------------------------------------------ categories -- */

router.get('/meta/categories', requirePermission('expenses.view', 'expenses.create'),
  handler(async (req, res) => {
    res.json({
      rows: await query(`SELECT id, name, is_active, is_system FROM expense_categories
                    WHERE is_active = 1 ORDER BY lower(name), name`),
    });
  }));

router.post('/meta/categories', requirePermission('settings.manage'), handler(async (req, res) => {
  const data = check(req.body).string('name', { required: true, min: 2, max: 120, label: 'Name' }).result();
  const existing = await queryOne(
    'SELECT id FROM expense_categories WHERE lower(name) = lower($name)', { name: data.name });
  if (existing) throw validationError({ name: 'A category with that name already exists' });

  const now = nowIso();
  const result = await execute(
    `INSERT INTO expense_categories (name, is_active, is_system, created_by, created_at, updated_at)
     VALUES ($name, 1, 0, $actor, $now, $now)
     RETURNING id`,
    { name: data.name, actor: req.user.id, now }
  );
  const id = Number(result.lastInsertRowid);
  await audit(req, 'expense_category', id, 'created', { name: { from: null, to: data.name } });
  res.status(201).json({ category: await queryOne('SELECT * FROM expense_categories WHERE id = $id', { id }) });
}));

router.get('/:id', requirePermission('expenses.view'), handler(async (req, res) => {
  const row = await queryOne(`${SELECT} WHERE e.id = $id`, { id: Number(req.params.id) });
  if (!row) throw notFound('Expense not found');
  if (!req.actor.allowsScope('org_unit', row.ssn_id)) throw notFound('Expense not found');
  res.json({ expense: row });
}));

/* ----------------------------------------------------------------- writes -- */

function validateExpense(req, { partial = false } = {}) {
  const required = !partial;
  return check(req.body)
    .int('ssn_id', { required, min: 1, label: 'SSN' })
    .month('accounting_month', { required, label: 'Accounting month' })
    .date('expense_date', { required, label: 'Expense date' })
    .amount('amount', { required, min: 1, label: 'Amount' })
    .int('category_id', { required, min: 1, label: 'Category' })
    .string('description', { max: 2000, label: 'Description' })
    .string('vendor', { max: 160, label: 'Vendor' })
    .string('payment_method', { max: 80, label: 'Payment method' })
    .string('payment_reference', { max: 120, label: 'Payment reference' })
    .enum('status', ['draft', 'approved', 'void'], { label: 'Status' })
    .int('attachment_id', { min: 1, label: 'Attachment' })
    .result();
}

async function assertSsn(req, ssnId) {
  const ssn = await queryOne('SELECT * FROM org_units WHERE id = $id', { id: ssnId });
  if (!ssn || ssn.kind !== 'ssn') throw validationError({ ssn_id: 'Choose an SSN' });
  if (!req.actor.allowsScope('org_unit', ssn.id)) {
    throw validationError({ ssn_id: 'You are not authorised to charge this SSN' });
  }
  if (!ssn.is_active) {
    throw validationError({ ssn_id: `${ssn.name} is deactivated. Reactivate it first.` });
  }
  return ssn;
}

async function assertCategory(categoryId) {
  const category = await queryOne('SELECT * FROM expense_categories WHERE id = $id', { id: categoryId });
  if (!category || !category.is_active) throw validationError({ category_id: 'Select a valid category' });
  return category;
}

router.post('/', requirePermission('expenses.create'), handler(async (req, res) => {
  const data = validateExpense(req);
  await assertSsn(req, data.ssn_id);
  await assertCategory(data.category_id);
  const now = nowIso();

  const id = await insertWithReference('expenses', 'EX', data.accounting_month, async (reference) => {
    const result = await execute(
      `INSERT INTO expenses
         (reference, ssn_id, accounting_month, expense_date, amount_cents, category_id,
          description, vendor, payment_method, payment_reference, status, attachment_id,
          created_by, created_at, updated_by, updated_at)
       VALUES ($reference, $ssn_id, $accounting_month, $expense_date, $amount, $category_id,
               $description, $vendor, $method, $payment_reference, $status, $attachment_id,
               $actor, $now, $actor, $now)
       RETURNING id`,
      {
        reference,
        ssn_id: data.ssn_id,
        accounting_month: data.accounting_month,
        expense_date: data.expense_date,
        amount: data.amount_cents,
        category_id: data.category_id,
        description: data.description ?? null,
        vendor: data.vendor ?? null,
        method: data.payment_method ?? null,
        payment_reference: data.payment_reference ?? null,
        status: data.status ?? 'approved',
        attachment_id: data.attachment_id ?? null,
        actor: req.user.id,
        now,
      }
    );
    return Number(result.lastInsertRowid);
  });

  await audit(req, 'expense', id, 'created', {
    ssn_id: { from: null, to: data.ssn_id },
    accounting_month: { from: null, to: data.accounting_month },
    amount_cents: { from: null, to: data.amount_cents },
  });

  res.status(201).json({ expense: await queryOne(`${SELECT} WHERE e.id = $id`, { id }) });
}));

const TRACKED = [
  'ssn_id', 'accounting_month', 'expense_date', 'amount_cents', 'category_id',
  'description', 'vendor', 'payment_method', 'payment_reference', 'status', 'attachment_id',
];

router.put('/:id', requirePermission('expenses.edit'), handler(async (req, res) => {
  const existing = await queryOne('SELECT * FROM expenses WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Expense not found');
  if (!req.actor.allowsScope('org_unit', existing.ssn_id)) throw notFound('Expense not found');

  const data = validateExpense(req, { partial: true });
  if (data.ssn_id && data.ssn_id !== existing.ssn_id) await assertSsn(req, data.ssn_id);
  if (data.category_id && data.category_id !== existing.category_id) await assertCategory(data.category_id);

  const next = {
    ssn_id: data.ssn_id ?? existing.ssn_id,
    accounting_month: data.accounting_month ?? existing.accounting_month,
    expense_date: data.expense_date ?? existing.expense_date,
    amount_cents: data.amount_cents ?? existing.amount_cents,
    category_id: data.category_id ?? existing.category_id,
    description: data.description ?? existing.description,
    vendor: data.vendor ?? existing.vendor,
    payment_method: data.payment_method ?? existing.payment_method,
    payment_reference: data.payment_reference ?? existing.payment_reference,
    status: data.status ?? existing.status,
    attachment_id: data.attachment_id ?? existing.attachment_id,
  };

  await execute(
    `UPDATE expenses
        SET ssn_id = $ssn_id, accounting_month = $accounting_month,
            expense_date = $expense_date, amount_cents = $amount_cents,
            category_id = $category_id, description = $description, vendor = $vendor,
            payment_method = $payment_method, payment_reference = $payment_reference,
            status = $status, attachment_id = $attachment_id,
            updated_by = $actor, updated_at = $now
      WHERE id = $id`,
    { ...next, id: existing.id, actor: req.user.id, now: nowIso() }
  );

  const changes = diff(existing, next, TRACKED);
  if (Object.keys(changes).length) await audit(req, 'expense', existing.id, 'updated', changes);

  res.json({ expense: await queryOne(`${SELECT} WHERE e.id = $id`, { id: existing.id }) });
}));

router.delete('/:id', requirePermission('expenses.delete'), handler(async (req, res) => {
  await assertDeletionAllowed();
  const existing = await queryOne('SELECT * FROM expenses WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Expense not found');
  if (!req.actor.allowsScope('org_unit', existing.ssn_id)) throw notFound('Expense not found');

  // Large write-offs need a reason on the record, not just in someone's memory.
  const threshold = Number((await getSetting('require_reason_above_cents')) ?? 0);
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) throw badRequest('A reason is required to delete an expense');
  if (threshold && existing.amount_cents >= threshold && reason.length < 10) {
    throw badRequest('Give a fuller reason for deleting an expense of this size');
  }

  await execute('DELETE FROM expenses WHERE id = $id', { id: existing.id });

  await audit(req, 'expense', existing.id, 'deleted', {
    reference: { from: existing.reference, to: null },
    amount_cents: { from: existing.amount_cents, to: null },
  }, reason);

  res.json({ deleted: true });
}));

export default router;
