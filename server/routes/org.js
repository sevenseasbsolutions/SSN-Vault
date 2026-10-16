/**
 * The company structure: main company, sub-companies, SSNs.
 *
 * Shape rules live here because SQL can only express half of them:
 *   - exactly one main company
 *   - a sub-company's parent is the main company
 *   - an SSN's parent is a sub-company, and it carries a share and a
 *     tax rate
 *
 * An SSN's share is what it KEEPS. The rest travels up the tree, so
 * setting Alpha to 30% means 70% reaches MBS1 and then MBS.
 */

import { Router } from 'express';
import { query, queryOne, execute, transaction } from '../db/connection.js';
import { handler } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, conflict, validationError, forbidden } from '../lib/errors.js';
import { nowIso, toMonth } from '../lib/dates.js';
import { audit, diff } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { assertDeletionAllowed } from '../lib/deletion.js';
import { orgTree, mainUnit, unitById, ssnMonth, salaryLinesFor } from '../services/rollup.js';

const router = Router();
router.use(requireAuth);

const KINDS = ['main', 'sub', 'ssn'];

const visible = (req, unit) => req.actor.allowsScope('org_unit', unit.id);

/* ------------------------------------------------------------------ reads -- */

/**
 * The whole tree in one response, nested, with each SSN's share.
 *
 * A scoped user sees only the units they were granted, but always with their
 * ancestors attached: an SSN is meaningless without the company above it.
 */
router.get('/', requirePermission('org.view'), handler((req, res) => {
  const flat = orgTree();
  const allowed = req.actor.scope('org_unit');

  let kept = flat;
  if (allowed !== null) {
    const keep = new Set();
    for (const unit of flat) {
      if (!allowed.includes(unit.id)) continue;
      // Walk the stored path so ancestors come along.
      for (const id of unit.path.split('/')) keep.add(Number(id));
    }
    kept = flat.filter((u) => keep.has(u.id));
  }

  const byId = new Map(kept.map((u) => [u.id, { ...u, children: [] }]));
  const roots = [];
  for (const unit of byId.values()) {
    const parent = unit.parent_id === null ? null : byId.get(unit.parent_id);
    if (parent) parent.children.push(unit);
    else roots.push(unit);
  }

  res.json({ rows: kept, tree: roots, main: mainUnit() });
}));

/** Flat SSN list, for the pickers every form needs. */
router.get('/meta/ssns', requirePermission('org.view', 'jobs.view', 'expenses.view'),
  handler((req, res) => {
    const clauses = ["d.kind = 'ssn'"];
    const params = {};
    const allowed = req.actor.scope('org_unit');
    if (allowed !== null) {
      if (allowed.length === 0) return res.json({ rows: [] });
      clauses.push(`d.id IN (${allowed.map((_, i) => `$s${i}`).join(',')})`);
      allowed.forEach((id, i) => { params[`s${i}`] = id; });
    }
    if (req.query.active_only !== 'false') clauses.push('d.is_active = 1');

    res.json({
      rows: query(`
        SELECT d.id, d.name, d.code, d.share_bps, d.is_active,
               s.id AS sub_id, s.name AS sub_name
          FROM org_units d
          JOIN org_units s ON s.id = d.parent_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY s.name COLLATE NOCASE, d.name COLLATE NOCASE
      `, params),
    });
  }));

/** Sub-companies, for the SSN form's parent picker. */
router.get('/meta/sub-companies', requirePermission('org.view'), handler((req, res) => {
  res.json({
    rows: query("SELECT id, name, code, is_active FROM org_units WHERE kind = 'sub' ORDER BY name COLLATE NOCASE"),
  });
}));

router.get('/:id', requirePermission('org.view'), handler((req, res) => {
  const unit = unitById(req.params.id);
  if (!unit) throw notFound('That part of the company structure was not found');
  if (!visible(req, unit)) throw notFound('That part of the company structure was not found');

  const children = query(
    'SELECT * FROM org_units WHERE parent_id = $id ORDER BY name COLLATE NOCASE',
    { id: unit.id }
  );
  const parent = unit.parent_id ? unitById(unit.parent_id) : null;
  res.json({ unit, parent, children });
}));

/* ----------------------------------------------------------------- writes -- */

function validateUnit(req, { partial = false } = {}) {
  const required = !partial;
  return check(req.body)
    .string('name', { required, min: 1, max: 120, label: 'Name' })
    .enum('kind', KINDS, { required, label: 'Kind' })
    .int('parent_id', { min: 1, label: 'Parent' })
    /*
     * share() takes the BASE name: it accepts either a percentage in `share`
     * or basis points in `share_bps`, and always writes `share_bps`. Passing
     * 'share_bps' here would look for `share_bps_bps` and silently read a
     * percentage as basis points -- 30% becoming 0.3%.
     */
    .share('share', { label: 'Share' })
    .string('code', { max: 40, label: 'Code' })
    .string('description', { max: 2000, label: 'Description' })
    .bool('is_active', { label: 'Active' })
    .result();
}

/**
 * Enforce the shape rules a CHECK constraint cannot see: that there is only
 * ever one main company, and that each kind sits under the right parent.
 */
function assertShape(kind, parentId, { excludeId = null } = {}) {
  if (kind === 'main') {
    const existing = queryOne(
      'SELECT id FROM org_units WHERE kind = $kind AND ($exclude IS NULL OR id <> $exclude)',
      { kind, exclude: excludeId }
    );
    if (existing) {
      throw validationError({
        kind: 'A main company already exists. Add a sub-company or an SSN instead.',
      });
    }
    return null;
  }

  if (!parentId) {
    throw validationError({
      parent_id: kind === 'sub'
        ? 'Choose the main company this sub-company belongs to'
        : 'Choose the sub-company this SSN belongs to',
    });
  }
  const parent = unitById(parentId);
  if (!parent) throw validationError({ parent_id: 'That parent does not exist' });

  const expected = kind === 'sub' ? 'main' : 'sub';
  if (parent.kind !== expected) {
    throw validationError({
      parent_id: kind === 'sub'
        ? 'A sub-company must sit directly under the main company'
        : 'An SSN must sit under a sub-company, not under the main company',
    });
  }
  return parent.id;
}

/**
 * An SSN must have a share; nothing else may.
 *
 * There is no tax rate here. Tax is asked for on each job and applied to that
 * job's own salary, so two jobs in the same month can be taxed differently.
 */
function assertSsnFields(kind, { share_bps }) {
  if (kind === 'ssn') {
    if (share_bps === null || share_bps === undefined) {
      throw validationError({ share: 'Set the percentage this SSN keeps' });
    }
    return { share_bps };
  }
  return { share_bps: null };
}

router.post('/', requirePermission('org.manage'), handler((req, res) => {
  const data = validateUnit(req);
  const parentId = assertShape(data.kind, data.parent_id);
  const shares = assertSsnFields(data.kind, data);

  const now = nowIso();
  const duplicate = queryOne(
    `SELECT id FROM org_units
      WHERE lower(name) = lower($name)
        AND ((parent_id IS NULL AND $parent IS NULL) OR parent_id = $parent)`,
    { name: data.name, parent: parentId }
  );
  if (duplicate) {
    throw validationError({ name: 'Something with that name already exists at this level' });
  }

  const result = execute(
    `INSERT INTO org_units
       (name, kind, parent_id, share_bps, code, description, is_active,
        created_by, created_at, updated_by, updated_at)
     VALUES ($name, $kind, $parent, $share, $code, $description, $is_active,
             $actor, $now, $actor, $now)`,
    {
      name: data.name,
      kind: data.kind,
      parent: parentId,
      share: shares.share_bps,
      code: data.code ?? null,
      description: data.description ?? null,
      is_active: data.is_active === false ? 0 : 1,
      actor: req.user.id,
      now,
    }
  );
  const id = Number(result.lastInsertRowid);

  audit(req, 'org_unit', id, 'created', {
    name: { from: null, to: data.name },
    kind: { from: null, to: data.kind },
    parent_id: { from: null, to: parentId },
    share_bps: { from: null, to: shares.share_bps },
  });

  res.status(201).json({ unit: unitById(id) });
}));

const TRACKED = ['name', 'share_bps', 'code', 'description', 'is_active'];

router.put('/:id', requirePermission('org.manage'), handler((req, res) => {
  const existing = unitById(req.params.id);
  if (!existing) throw notFound('That part of the company structure was not found');

  const data = validateUnit(req, { partial: true });
  // Kind and parent are structural: moving an SSN between sub-companies
  // would silently restate history, so they are fixed once created.
  if (data.kind && data.kind !== existing.kind) {
    throw validationError({ kind: 'The kind cannot be changed after it is created' });
  }
  if (data.parent_id && data.parent_id !== existing.parent_id) {
    throw validationError({ parent_id: 'Create a new SSN instead of moving this one' });
  }
  if (existing.kind !== 'ssn' && data.share_bps !== undefined) {
    throw validationError({
      share: 'Only an SSN has a share. A sub-company passes everything up.',
    });
  }

  const next = {
    name: data.name ?? existing.name,
    share_bps: data.share_bps ?? existing.share_bps,
    code: data.code ?? existing.code,
    description: data.description ?? existing.description,
    is_active: data.is_active === undefined ? existing.is_active : (data.is_active ? 1 : 0),
  };

  if (next.name.toLowerCase() !== existing.name.toLowerCase()) {
    const duplicate = queryOne(
      `SELECT id FROM org_units
        WHERE lower(name) = lower($name) AND id <> $id
          AND ((parent_id IS NULL AND $parent IS NULL) OR parent_id = $parent)`,
      { name: next.name, id: existing.id, parent: existing.parent_id }
    );
    if (duplicate) {
      throw validationError({ name: 'Something with that name already exists at this level' });
    }
  }

  execute(
    `UPDATE org_units
        SET name = $name, share_bps = $share, code = $code,
            description = $description, is_active = $is_active,
            updated_by = $actor, updated_at = $now
      WHERE id = $id`,
    {
      id: existing.id,
      name: next.name,
      share: next.share_bps,
      code: next.code,
      description: next.description,
      is_active: next.is_active,
      actor: req.user.id,
      now: nowIso(),
    }
  );

  const changes = diff(existing, next, TRACKED);
  if (Object.keys(changes).length) audit(req, 'org_unit', existing.id, 'updated', changes);

  res.json({ unit: unitById(existing.id) });
}));

/**
 * Delete only something that holds no history.
 *
 * An SSN with jobs or expenses behind it is deactivated instead: its
 * past months must keep reconciling, and dropping the row would orphan every
 * figure that was ever reported from it.
 */
router.delete('/:id', requirePermission('org.manage'), handler((req, res) => {
  assertDeletionAllowed();
  const existing = unitById(req.params.id);
  if (!existing) throw notFound('That part of the company structure was not found');

  const children = Number(queryOne(
    'SELECT COUNT(*) AS n FROM org_units WHERE parent_id = $id', { id: existing.id }).n);
  if (children > 0) {
    throw conflict(`Remove the ${children} item(s) underneath this one first`);
  }

  const jobs = Number(queryOne(
    'SELECT COUNT(*) AS n FROM jobs WHERE ssn_id = $id', { id: existing.id }).n);
  const expenses = Number(queryOne(
    'SELECT COUNT(*) AS n FROM expenses WHERE ssn_id = $id', { id: existing.id }).n);
  if (jobs > 0 || expenses > 0) {
    throw conflict(
      `This SSN has ${jobs} job(s) and ${expenses} expense(s) recorded against it. `
      + 'Deactivate it instead, so its past months keep reconciling.'
    );
  }

  transaction(() => {
    execute('DELETE FROM tax_overrides WHERE ssn_id = $id', { id: existing.id });
    execute('DELETE FROM org_units WHERE id = $id', { id: existing.id });
  });

  audit(req, 'org_unit', existing.id, 'deleted', {
    name: { from: existing.name, to: null },
    kind: { from: existing.kind, to: null },
  });

  res.json({ deleted: true });
}));

/* -------------------------------------------------------------- statement -- */

/**
 * One SSN's month, as the full waterfall.
 *
 * This is the screen that answers "where did Alpha's money go", so it returns
 * the computed figures together with the rows they were computed from.
 */
router.get('/:id/statement', requirePermission('reports.view', 'org.view'),
  handler((req, res) => {
    const ssn = unitById(req.params.id);
    if (!ssn || ssn.kind !== 'ssn') throw notFound('SSN not found');
    if (!visible(req, ssn)) throw notFound('SSN not found');

    const month = toMonth(req.query.month);
    if (!month) throw validationError({ month: 'Give the accounting month as YYYY-MM' });

    const statement = ssnMonth(ssn, month);
    const sub = ssn.parent_id ? unitById(ssn.parent_id) : null;

    res.json({
      statement: { ...statement, sub_name: sub?.name ?? null },
      // The salary lines the figures above were summed from, each with its
      // own derived withheld / hold / to-the-SSN amounts.
      salaries: salaryLinesFor(ssn.id, month),
      expenses: query(
        `SELECT e.id, e.reference, e.expense_date, e.description, e.vendor,
                e.amount_cents, e.status, c.name AS category_name
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id
          WHERE e.ssn_id = $id AND e.accounting_month = $month
          ORDER BY e.expense_date, e.id`,
        { id: ssn.id, month }
      ),
    });
  }));

export default router;
