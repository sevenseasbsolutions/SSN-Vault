/**
 * Jobs: the engagements an SSN works under.
 *
 * A job holds no money. It carries the terms the money will be treated by --
 * the tax category, the tax-hold percentage, the joining date -- and the
 * salaries recorded against it supply the amounts, one per month.
 *
 * That is why there is no accounting month here: a job spans months, and the
 * month belongs to each salary.
 */

import { Router } from 'express';
import { query, queryOne, execute } from '../db/connection.js';
import { handler, pagination, sorting, paged, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, validationError, badRequest, conflict } from '../lib/errors.js';
import { nowIso, toMonth } from '../lib/dates.js';
import { audit, diff } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { assertDeletionAllowed } from '../lib/deletion.js';
import { insertWithReference } from '../lib/reference.js';
import { applyScope } from '../auth/permissions.js';

const router = Router();
router.use(requireAuth);

const CATEGORIES = ['w2', '1099'];

const SORTABLE = {
  title: 'j.title',
  client: 'j.client_name',
  ssn: 'd.name',
  joining_date: 'j.joining_date',
  tax_category: 'j.tax_category',
  tax_hold: 'j.tax_hold_bps',
  created_at: 'j.created_at',
};

/*
 * A job is only interesting alongside what it has actually paid, so the list
 * carries its salary totals rather than making every caller join for them.
 * Only 'active' salaries count, matching the engine.
 */
const SELECT = `
  SELECT j.*, d.name AS ssn_name, d.share_bps, s.id AS sub_id, s.name AS sub_name,
         cu.name AS created_by_name, uu.name AS updated_by_name,
         (SELECT COUNT(*) FROM salaries sa
           WHERE sa.job_id = j.id AND sa.status = 'active') AS salary_count,
         (SELECT COALESCE(SUM(sa.credited_amount_cents), 0) FROM salaries sa
           WHERE sa.job_id = j.id AND sa.status = 'active') AS credited_total,
         (SELECT COALESCE(SUM(sa.invoice_amount_cents - sa.credited_amount_cents), 0)
            FROM salaries sa WHERE sa.job_id = j.id AND sa.status = 'active') AS withheld_total,
         (SELECT MAX(sa.accounting_month) FROM salaries sa
           WHERE sa.job_id = j.id AND sa.status = 'active') AS last_month
    FROM jobs j
    JOIN org_units d ON d.id = j.ssn_id
    JOIN org_units s ON s.id = d.parent_id
    LEFT JOIN users cu ON cu.id = j.created_by
    LEFT JOIN users uu ON uu.id = j.updated_by
`;

const JOINS = `FROM jobs j
    JOIN org_units d ON d.id = j.ssn_id
    JOIN org_units s ON s.id = d.parent_id`;

function buildFilters(req) {
  const clauses = [];
  const params = {};
  const f = req.query;

  if (!applyScope(req.actor, 'org_unit', 'j.ssn_id', clauses, params, 'scope')) {
    return { clauses, params, empty: true };
  }

  if (f.ssn_id) { clauses.push('j.ssn_id = $f_ssn'); params.f_ssn = Number(f.ssn_id); }
  if (f.sub_id) { clauses.push('s.id = $f_sub'); params.f_sub = Number(f.sub_id); }
  if (f.tax_category) { clauses.push('j.tax_category = $f_cat'); params.f_cat = String(f.tax_category); }
  if (f.active === 'true') clauses.push('j.is_active = 1');
  if (f.active === 'false') clauses.push('j.is_active = 0');
  if (f.joined_from) { clauses.push('j.joining_date >= $f_jf'); params.f_jf = String(f.joined_from).slice(0, 10); }
  if (f.joined_to) { clauses.push('j.joining_date <= $f_jt'); params.f_jt = String(f.joined_to).slice(0, 10); }
  if (f.search) {
    // ILIKE: SQLite's LIKE was case-insensitive, and searches were written for that.
    clauses.push('(j.title ILIKE $f_q OR j.client_name ILIKE $f_q OR j.reference ILIKE $f_q)');
    params.f_q = `%${String(f.search).replace(/[%_]/g, '')}%`;
  }
  return { clauses, params, empty: false };
}

const whereSql = (clauses) => (clauses.length ? `WHERE ${clauses.join(' AND ')}` : '');

router.get('/', requirePermission('jobs.view'), handler(async (req, res) => {
  const { clauses, params, empty } = buildFilters(req);
  const page = pagination(req);
  const sort = sorting(req, SORTABLE, 'joining_date');

  if (empty) {
    return noStore(res).json({
      ...paged([], 0, page), sort,
      totals: { jobs: 0, active: 0, credited_total_cents: 0, withheld_total_cents: 0 },
    });
  }

  const where = whereSql(clauses);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n ${JOINS} ${where}`, params)).n);
  const rows = await query(
    `${SELECT} ${where} ORDER BY ${sort.sql}, j.id DESC LIMIT $limit OFFSET $offset`,
    { ...params, limit: page.limit, offset: page.offset }
  );

  const totals = await queryOne(
    `SELECT COUNT(*) AS jobs,
            COALESCE(SUM(j.is_active), 0) AS active,
            COALESCE(SUM((SELECT COALESCE(SUM(sa.credited_amount_cents), 0) FROM salaries sa
                           WHERE sa.job_id = j.id AND sa.status = 'active')), 0) AS credited_total,
            COALESCE(SUM((SELECT COALESCE(SUM(sa.invoice_amount_cents - sa.credited_amount_cents), 0)
                           FROM salaries sa WHERE sa.job_id = j.id AND sa.status = 'active')), 0)
              AS withheld_total
       ${JOINS} ${where}`, params);

  noStore(res).json({
    ...paged(rows, total, page),
    sort,
    totals: {
      jobs: Number(totals.jobs),
      active: Number(totals.active),
      credited_total_cents: Number(totals.credited_total),
      withheld_total_cents: Number(totals.withheld_total),
    },
  });
}));

/** Jobs a salary can be recorded against: active ones only. */
router.get('/meta/open', requirePermission('jobs.view'), handler(async (req, res) => {
  const clauses = ['j.is_active = 1'];
  const params = {};
  if (!applyScope(req.actor, 'org_unit', 'j.ssn_id', clauses, params, 'scope')) {
    return res.json({ rows: [] });
  }
  if (req.query.ssn_id) { clauses.push('j.ssn_id = $ssn'); params.ssn = Number(req.query.ssn_id); }

  res.json({
    rows: await query(`
      SELECT j.id, j.reference, j.title, j.client_name, j.tax_category, j.tax_hold_bps,
             j.joining_date, d.id AS ssn_id, d.name AS ssn_name, s.name AS sub_name
        ${JOINS}
       WHERE ${clauses.join(' AND ')}
       ORDER BY lower(s.name), s.name, lower(d.name), d.name, lower(j.title), j.title
    `, params),
  });
}));

router.get('/:id', requirePermission('jobs.view'), handler(async (req, res) => {
  const row = await queryOne(`${SELECT} WHERE j.id = $id`, { id: Number(req.params.id) });
  if (!row) throw notFound('Job not found');
  if (!req.actor.allowsScope('org_unit', row.ssn_id)) throw notFound('Job not found');

  // Its salaries, so the job screen can show what it has actually paid.
  const salaries = await query(
    `SELECT id, reference, accounting_month, invoice_amount_cents, credited_amount_cents,
            credit_date, pay_period_from, pay_period_to, status
       FROM salaries WHERE job_id = $id ORDER BY accounting_month DESC, id DESC`,
    { id: row.id }
  );
  res.json({ job: row, salaries });
}));

/* ----------------------------------------------------------------- writes -- */

function validateJob(req, { partial = false } = {}) {
  const required = !partial;
  return check(req.body)
    .int('ssn_id', { required, min: 1, label: 'SSN' })
    .string('title', { required, min: 1, max: 200, label: 'Job' })
    .string('client_name', { max: 160, label: 'Client' })
    .enum('tax_category', CATEGORIES, { required, label: 'Tax category' })
    /*
     * share() takes the base name: it accepts a percentage in `tax_hold` or
     * basis points in `tax_hold_bps`, and always writes `tax_hold_bps`.
     */
    .share('tax_hold', { required, label: 'Tax hold' })
    .date('joining_date', { required, label: 'Joining date' })
    .bool('is_active', { label: 'Active' })
    .string('notes', { max: 2000, label: 'Notes' })
    .int('attachment_id', { min: 1, label: 'Attachment' })
    .result();
}

async function assertSsn(req, ssnId) {
  const ssn = await queryOne('SELECT * FROM org_units WHERE id = $id', { id: ssnId });
  if (!ssn || ssn.kind !== 'ssn') throw validationError({ ssn_id: 'Choose an SSN' });
  if (!req.actor.allowsScope('org_unit', ssn.id)) {
    throw validationError({ ssn_id: 'You are not authorised to record against this SSN' });
  }
  if (!ssn.is_active) {
    throw validationError({ ssn_id: `${ssn.name} is deactivated. Reactivate it first.` });
  }
  return ssn;
}

router.post('/', requirePermission('jobs.create'), handler(async (req, res) => {
  const data = validateJob(req);
  await assertSsn(req, data.ssn_id);
  const now = nowIso();

  // A job has no accounting month, so its reference is sequenced by the month
  // the engagement started in.
  const id = await insertWithReference('jobs', 'JOB', toMonth(data.joining_date), async (reference) => {
    const result = await execute(
      `INSERT INTO jobs
         (reference, ssn_id, title, client_name, tax_category, tax_hold_bps, joining_date,
          is_active, notes, attachment_id, created_by, created_at, updated_by, updated_at)
       VALUES ($reference, $ssn_id, $title, $client, $category, $hold, $joining_date,
               $is_active, $notes, $attachment_id, $actor, $now, $actor, $now)
       RETURNING id`,
      {
        reference,
        ssn_id: data.ssn_id,
        title: data.title,
        client: data.client_name ?? null,
        category: data.tax_category,
        hold: data.tax_hold_bps,
        joining_date: data.joining_date,
        is_active: data.is_active === false ? 0 : 1,
        notes: data.notes ?? null,
        attachment_id: data.attachment_id ?? null,
        actor: req.user.id,
        now,
      }
    );
    return Number(result.lastInsertRowid);
  });

  await audit(req, 'job', id, 'created', {
    ssn_id: { from: null, to: data.ssn_id },
    title: { from: null, to: data.title },
    tax_category: { from: null, to: data.tax_category },
    tax_hold_bps: { from: null, to: data.tax_hold_bps },
    joining_date: { from: null, to: data.joining_date },
  });

  res.status(201).json({ job: await queryOne(`${SELECT} WHERE j.id = $id`, { id }) });
}));

const TRACKED = [
  'ssn_id', 'title', 'client_name', 'tax_category', 'tax_hold_bps',
  'joining_date', 'is_active', 'notes', 'attachment_id',
];

router.put('/:id', requirePermission('jobs.edit'), handler(async (req, res) => {
  const existing = await queryOne('SELECT * FROM jobs WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Job not found');
  if (!req.actor.allowsScope('org_unit', existing.ssn_id)) throw notFound('Job not found');

  const data = validateJob(req, { partial: true });
  if (data.ssn_id && data.ssn_id !== existing.ssn_id) await assertSsn(req, data.ssn_id);

  const next = {
    ssn_id: data.ssn_id ?? existing.ssn_id,
    title: data.title ?? existing.title,
    client_name: data.client_name ?? existing.client_name,
    tax_category: data.tax_category ?? existing.tax_category,
    tax_hold_bps: data.tax_hold_bps ?? existing.tax_hold_bps,
    joining_date: data.joining_date ?? existing.joining_date,
    is_active: data.is_active === undefined ? existing.is_active : (data.is_active ? 1 : 0),
    notes: data.notes ?? existing.notes,
    attachment_id: data.attachment_id ?? existing.attachment_id,
  };

  await execute(
    `UPDATE jobs
        SET ssn_id = $ssn_id, title = $title, client_name = $client_name,
            tax_category = $tax_category, tax_hold_bps = $tax_hold_bps,
            joining_date = $joining_date, is_active = $is_active, notes = $notes,
            attachment_id = $attachment_id, updated_by = $actor, updated_at = $now
      WHERE id = $id`,
    { ...next, id: existing.id, actor: req.user.id, now: nowIso() }
  );

  const changes = diff(existing, next, TRACKED);
  if (Object.keys(changes).length) await audit(req, 'job', existing.id, 'updated', changes);

  /*
   * Changing the hold restates every month this job has already paid into,
   * because the engine derives each hold from the job's current rate. Say so,
   * rather than letting a past month's figure move without anyone noticing.
   */
  const restated = changes.tax_hold_bps
    ? Number((await queryOne(
      "SELECT COUNT(DISTINCT accounting_month) AS n FROM salaries"
      + " WHERE job_id = $id AND status = 'active'",
      { id: existing.id }
    )).n)
    : 0;

  res.json({
    job: await queryOne(`${SELECT} WHERE j.id = $id`, { id: existing.id }),
    warnings: restated > 0
      ? [`The tax hold changed, so ${restated} month(s) already recorded against this job `
        + 'have been restated.']
      : [],
  });
}));

router.delete('/:id', requirePermission('jobs.delete'), handler(async (req, res) => {
  await assertDeletionAllowed();
  const existing = await queryOne('SELECT * FROM jobs WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('Job not found');
  if (!req.actor.allowsScope('org_unit', existing.ssn_id)) throw notFound('Job not found');

  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) throw badRequest('A reason is required to delete a job');

  // A job with salaries behind it cannot go: its months must keep reconciling.
  const salaries = Number((await queryOne(
    'SELECT COUNT(*) AS n FROM salaries WHERE job_id = $id', { id: existing.id })).n);
  if (salaries > 0) {
    throw conflict(
      `This job has ${salaries} salary record(s) against it. Mark it inactive instead, `
      + 'so its past months keep reconciling.'
    );
  }

  await execute('DELETE FROM jobs WHERE id = $id', { id: existing.id });

  await audit(req, 'job', existing.id, 'deleted', {
    reference: { from: existing.reference, to: null },
    title: { from: existing.title, to: null },
  }, reason);

  res.json({ deleted: true });
}));

export default router;
