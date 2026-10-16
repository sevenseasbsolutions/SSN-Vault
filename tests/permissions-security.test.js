/**
 * Permissions, scope isolation and the audit trail.
 *
 * Access is enforced on the server for every read and write, and the one axis
 * that narrows it is the company tree: a user scoped to a sub-company reaches
 * its SSNs and nothing else. These tests try to get past that the ways
 * an attacker would -- by calling the endpoint directly, by guessing ids, and
 * by editing the request body to point at someone else's SSN.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, shutdown, ownerClient, createClient, makeWorld, makeUser,
  addJob, addSalary, addJobWithSalary, addExpense, cents, query, OWNER,
} from './helpers.js';

let owner;
let worldA;
let worldB;
let jobA;
let jobB;

before(async () => {
  await boot();
  owner = await ownerClient();
  worldA = await makeWorld(owner, { shareBps: 3000, taxRateBps: 2000 });
  worldB = await makeWorld(owner, { shareBps: 4000, taxRateBps: 2000 });

  jobA = await addJob(owner, worldA, { title: 'A job', taxPercent: 10 });
  jobB = await addJob(owner, worldB, { title: 'B job', taxPercent: 10 });
  await addSalary(owner, { jobId: jobA.id, month: '2026-08', invoice: '5000.00' });
  await addSalary(owner, { jobId: jobB.id, month: '2026-08', invoice: '4000.00' });
  await addExpense(owner, worldA, { month: '2026-08', amount: '1000.00' });
});
after(shutdown);

describe('permissions and security', () => {
  test('26. viewers cannot modify records through the API', async () => {
    const viewer = await makeUser(owner, { role: 'viewer' });

    const read = await viewer.client.get('/api/salaries?month_from=2026-08&month_to=2026-08');
    assert.equal(read.status, 200, 'a viewer may read');

    const createdJob = await viewer.client.post('/api/jobs', {
      ssn_id: worldA.ssnId, title: 'Sneaky job', tax_category: 'w2',
      tax_hold: 10, joining_date: '2026-08-01',
    });
    assert.equal(createdJob.status, 403, 'but may not set up a job');

    const createdSalary = await addSalary(viewer.client, {
      jobId: jobA.id, month: '2026-08', invoice: '10.00',
    });
    assert.equal(createdSalary.status, 403, 'nor record a salary');

    const existing = (await owner.get(`/api/salaries?ssn_id=${worldA.ssnId}`)).body.rows[0];
    const edited = await viewer.client.put(`/api/salaries/${existing.id}`, {
      invoice_amount: '1.00',
    });
    assert.equal(edited.status, 403, 'nor edit one');

    const deleted = await viewer.client.del(`/api/salaries/${existing.id}`, { reason: 'nope' });
    assert.equal(deleted.status, 403, 'nor delete one');

    const expense = await addExpense(viewer.client, worldA, { month: '2026-08', amount: '50.00' });
    assert.equal(expense.status, 403, 'nor record an expense');

    const unit = await viewer.client.post('/api/org', {
      name: 'Sneaky', kind: 'ssn', parent_id: worldA.subId, share: 99,
    });
    assert.equal(unit.status, 403, 'nor change the company structure');

    const override = await viewer.client.put('/api/tax/overrides', {
      ssn_id: worldA.ssnId, accounting_month: '2026-08', amount: '0', reason: 'nope',
    });
    assert.equal(override.status, 403, 'nor touch a tax hold');

    const after = (await owner.get(`/api/salaries/${existing.id}`)).body.salary;
    assert.equal(after.invoice_cents, existing.invoice_cents, 'the record is untouched');
  });

  test('27. a scoped user cannot reach another SSN by guessing IDs', async () => {
    const scoped = await makeUser(owner, {
      role: 'editor',
      scopes: [{ scope_type: 'org_unit', scope_id: worldA.ssnId }],
    });

    const own = await scoped.client.get('/api/salaries');
    assert.equal(own.status, 200);
    assert.ok(own.body.rows.length > 0, 'they see their own SSN');
    for (const row of own.body.rows) {
      assert.equal(Number(row.ssn_id), worldA.ssnId,
        'a scoped user must only ever see their own SSN');
    }

    // Another SSN's job, addressed directly by its id.
    const foreign = (await owner.get(`/api/salaries?ssn_id=${worldB.ssnId}`)).body.rows[0];
    const probe = await scoped.client.get(`/api/salaries/${foreign.id}`);
    assert.equal(probe.status, 404, 'a foreign record is indistinguishable from a missing one');

    // Walk a range of ids: nothing outside the granted SSN may surface.
    for (let id = 1; id <= 12; id += 1) {
      const result = await scoped.client.get(`/api/salaries/${id}`);
      if (result.status === 200) {
        assert.equal(Number(result.body.salary.ssn_id), worldA.ssnId);
      } else {
        assert.equal(result.status, 404);
      }
    }

    // Posting revenue into another SSN by editing the request body.
    const crossWrite = await addSalary(scoped.client, {
      jobId: jobB.id, month: '2026-08', invoice: '999.00',
    });
    assert.equal(crossWrite.status, 422,
      'a scoped user must not pay into a job they do not hold');

    const crossExpense = await addExpense(scoped.client, worldB, {
      month: '2026-08', amount: '999.00', ssnId: worldB.ssnId,
    });
    assert.equal(crossExpense.status, 422, 'nor charge one');

    // Nor read its statement, nor its tax position.
    const foreignStatement = await scoped.client.get(
      `/api/org/${worldB.ssnId}/statement?month=2026-08`);
    assert.equal(foreignStatement.status, 404);

    const taxView = await scoped.client.get('/api/tax?month=2026-08');
    assert.equal(taxView.status, 200);
    for (const row of taxView.body.rows) {
      assert.equal(Number(row.ssn_id), worldA.ssnId, 'the tax page is scoped too');
    }

    // The dashboard narrows rather than leaking the whole company.
    const dashboard = await scoped.client.get('/api/dashboard?month=2026-08');
    assert.equal(dashboard.status, 200);
    for (const row of dashboard.body.ssns) {
      assert.equal(Number(row.ssn_id), worldA.ssnId);
    }
    const statement = await scoped.client.get(
      `/api/org/${worldA.ssnId}/statement?month=2026-08`);
    assert.equal(
      dashboard.body.rollup.total_received_cents,
      statement.body.statement.upstream_cents,
      'a scoped roll-up totals only what the user can see'
    );
  });

  test('27b. granting a sub-company reaches its SSNs, including new ones', async () => {
    const scoped = await makeUser(owner, {
      role: 'editor',
      scopes: [{ scope_type: 'org_unit', scope_id: worldA.subId }],
    });

    const reachable = await scoped.client.get(`/api/org/${worldA.ssnId}/statement?month=2026-08`);
    assert.equal(reachable.status, 200, 'the granted sub-company\'s SSN is reachable');

    const foreign = await scoped.client.get(`/api/org/${worldB.ssnId}/statement?month=2026-08`);
    assert.equal(foreign.status, 404, 'an SSN under another sub-company is not');

    // An SSN added after the grant is covered without touching the grant.
    const added = await owner.post('/api/org', {
      name: `Later ${worldA.tag}`, kind: 'ssn', parent_id: worldA.subId, share: 50,
    });
    assert.equal(added.status, 201);
    const later = await scoped.client.get(
      `/api/org/${added.body.unit.id}/statement?month=2026-08`);
    assert.equal(later.status, 200, 'the grant expands on read, so it never goes stale');
  });

  test('28. unauthorised users cannot export restricted information', async () => {
    const noExport = await makeUser(owner, {
      role: 'viewer',
      permissions: [{ permission: 'reports.export', effect: 'deny' }],
    });

    const csv = await noExport.client.get('/api/reports/export/month?month=2026-08&format=csv');
    assert.equal(csv.status, 403, 'export is a permission of its own');

    const xlsx = await noExport.client.get('/api/reports/export/month?month=2026-08&format=xlsx');
    assert.equal(xlsx.status, 403);

    // A scoped exporter gets their own rows only, never the whole company.
    const scopedExporter = await makeUser(owner, {
      role: 'editor',
      scopes: [{ scope_type: 'org_unit', scope_id: worldA.ssnId }],
    });
    const scopedCsv = await scopedExporter.client.get(
      '/api/reports/export/month?month=2026-08&format=csv');
    assert.equal(scopedCsv.status, 200);
    assert.ok(!scopedCsv.text.includes('B job'), 'another SSN\'s work is not in the export');

    const foreignExport = await scopedExporter.client.get(
      `/api/reports/export/ssn/${worldB.ssnId}?format=csv`);
    assert.equal(foreignExport.status, 404);
  });

  test('29. users cannot grant themselves permissions', async () => {
    const editor = await makeUser(owner, { role: 'editor' });
    const selfGrant = await editor.client.put(`/api/users/${editor.id}/access`, {
      permissions: [{ permission: 'users.manage', effect: 'allow' }],
    });
    assert.equal(selfGrant.status, 403);

    const selfPromote = await editor.client.put(`/api/users/${editor.id}`, { role: 'owner' });
    assert.equal(selfPromote.status, 403);

    const stillEditor = (await owner.get(`/api/users/${editor.id}`)).body.user;
    assert.equal(stillEditor.role, 'editor');
    assert.ok(!stillEditor.effective_permissions.includes('users.manage'));

    // Even a second owner cannot edit their OWN role, permissions or status.
    const second = await makeUser(owner, { role: 'owner' });
    const ownSelfAccess = await second.client.put(`/api/users/${second.id}/access`, {
      permissions: [{ permission: 'settings.manage', effect: 'allow' }],
    });
    assert.equal(ownSelfAccess.status, 403);
    assert.match(ownSelfAccess.body.error.message, /cannot change your own/i);

    const ownSelfRole = await second.client.put(`/api/users/${second.id}`, { role: 'viewer' });
    assert.equal(ownSelfRole.status, 403);

    const ownSelfDeactivate = await second.client.put(`/api/users/${second.id}`, { is_active: false });
    assert.equal(ownSelfDeactivate.status, 403);

    // They can still administer other accounts, which is the point of the role.
    const other = await makeUser(owner, { role: 'viewer' });
    const allowed = await second.client.put(`/api/users/${other.id}`, { role: 'editor' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.user.role, 'editor');

    // A role change signs the account out, so it must sign in again to continue.
    const afterRoleChange = await other.client.get('/api/jobs');
    assert.equal(afterRoleChange.status, 401, 'changing a role revokes that user\'s sessions');
    await other.client.login(other.email, other.password);

    // Owner-only permissions cannot be granted to a non-owner account.
    const escalate = await owner.put(`/api/users/${other.id}/access`, {
      permissions: [{ permission: 'users.manage', effect: 'allow' }],
    });
    assert.equal(escalate.status, 422);
    assert.match(escalate.body.error.details.permissions, /only be held by an owner/i);

    // An explicit deny always wins over a role default.
    const denied = await owner.put(`/api/users/${other.id}/access`, {
      permissions: [{ permission: 'jobs.view', effect: 'deny' }],
    });
    assert.equal(denied.status, 200);
    const blocked = await other.client.get('/api/jobs');
    assert.equal(blocked.status, 403);

    // A deactivated account is locked out immediately.
    await owner.put(`/api/users/${other.id}`, { is_active: false });
    const afterDeactivation = await other.client.get('/api/jobs');
    assert.equal(afterDeactivation.status, 401);

    // And a state-changing request without the CSRF token is refused.
    const noCsrf = createClient();
    await noCsrf.login(OWNER.email, OWNER.password);
    const raw = await fetch(`${await boot()}/api/org`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'csrf attempt', kind: 'main' }),
    });
    assert.ok(raw.status === 401 || raw.status === 403,
      'a cookie-only cross-site request must not be able to write');
  });

  test('30. the audit history records financial edits and permission changes', async () => {
    const world = await makeWorld(owner, { shareBps: 3000, taxRateBps: 2000 });
    const created = await addJobWithSalary(owner, world, {
      month: '2026-08', invoice: '2000.00', taxPercent: 10, title: 'Audited job',
    });
    assert.equal(created.status, 201);
    const salaryId = created.body.salary.id;

    await owner.put(`/api/salaries/${salaryId}`, { invoice_amount: '2500.00' });

    const history = await owner.get(`/api/audit?entity_type=salary&entity_id=${salaryId}`);
    assert.equal(history.status, 200);
    const actions = history.body.rows.map((r) => r.action);
    assert.ok(actions.includes('created'), 'creation is recorded');
    assert.ok(actions.includes('updated'), 'the edit is recorded');

    const update = history.body.rows.find((r) => r.action === 'updated');
    const changes = update.changes ?? JSON.parse(update.changes_json);
    assert.equal(Number(changes.invoice_amount_cents.from), cents('2000'));
    assert.equal(Number(changes.invoice_amount_cents.to), cents('2500'));

    // A tax override is a financial act and is recorded as one.
    await owner.put('/api/tax/overrides', {
      ssn_id: world.ssnId, accounting_month: '2026-08',
      amount: '123.00', reason: 'audited override',
    });
    const taxHistory = await owner.get('/api/audit?entity_type=tax_override');
    assert.ok(taxHistory.body.rows.length > 0, 'the override is in the audit history');

    // Structural changes to the company are recorded too.
    const structure = await owner.get('/api/audit?entity_type=org_unit');
    assert.ok(structure.body.rows.some((r) => r.action === 'created'),
      'creating part of the company structure is audited');

    // Permission changes are audited against the user record.
    const target = await makeUser(owner, { role: 'viewer' });
    await owner.put(`/api/users/${target.id}/access`, {
      permissions: [{ permission: 'jobs.create', effect: 'allow' }],
    });
    const userHistory = await owner.get(`/api/audit?entity_type=user&entity_id=${target.id}`);
    assert.ok(userHistory.body.rows.length > 0, 'granting a permission is audited');

    // Every audit row names a real actor; nothing financial happens anonymously.
    const anonymous = (await query(
      'SELECT COUNT(*) AS n FROM audit_log WHERE user_id IS NULL'
      + " AND entity_type IN ('job','salary','expense')"
    ))[0];
    assert.equal(Number(anonymous.n), 0, 'no financial audit row is missing its author');
  });

  test('30b. the audit history can be exported as a file', async () => {
    const csv = await owner.get('/api/reports/audit-history?format=csv');
    assert.equal(csv.status, 200, 'the audit export endpoint the UI links to exists');
    assert.match(csv.text, /Record type/, 'the header row is present');
    assert.match(csv.text, /org_unit|job|expense/, 'and real rows came through');

    const viewer = await makeUser(owner, {
      role: 'viewer',
      permissions: [{ permission: 'audit.view', effect: 'deny' }],
    });
    const refused = await viewer.client.get('/api/reports/audit-history?format=csv');
    assert.equal(refused.status, 403, 'and it is gated on audit.view');
  });

  test('31. deleting is off until the owner turns it on', async () => {
    const world = await makeWorld(owner, { shareBps: 3000, taxRateBps: 0 });
    const created = await addJobWithSalary(owner, world, {
      month: '2026-08', invoice: '100.00', taxPercent: 10,
    });
    const salaryId = created.body.salary.id;

    await owner.put('/api/settings', { allow_delete: 'false' });
    const refused = await owner.del(`/api/salaries/${salaryId}`, { reason: 'testing the gate' });
    assert.equal(refused.status, 403, 'the setting gates deletion, not just the button');
    assert.match(refused.body.error.message, /switched off/i);

    await owner.put('/api/settings', { allow_delete: 'true' });
    const noReason = await owner.del(`/api/salaries/${salaryId}`);
    assert.equal(noReason.status, 400, 'a reason is required even once deletion is allowed');

    const deleted = await owner.del(`/api/salaries/${salaryId}`, { reason: 'recorded in error' });
    assert.equal(deleted.status, 200);

    const audit = await owner.get(`/api/audit?entity_type=salary&entity_id=${salaryId}`);
    assert.ok(audit.body.rows.some((r) => r.action === 'deleted'),
      'the deletion itself is in the audit history');

    await owner.put('/api/settings', { allow_delete: 'false' });
  });

  test('32. an SSN with history cannot be deleted out from under its records', async () => {
    const world = await makeWorld(owner, { shareBps: 3000, taxRateBps: 0 });
    await addJobWithSalary(owner, world, {
      month: '2026-08', invoice: '100.00', taxPercent: 10,
    });
    await owner.put('/api/settings', { allow_delete: 'true' });

    const refused = await owner.del(`/api/org/${world.ssnId}`);
    assert.equal(refused.status, 409, 'its past months must keep reconciling');
    assert.match(refused.body.error.message, /deactivate it instead/i);

    // The sub-company above it is equally protected while it has children.
    const parentRefused = await owner.del(`/api/org/${world.subId}`);
    assert.equal(parentRefused.status, 409);

    await owner.put('/api/settings', { allow_delete: 'false' });
  });

  test('33. the company shape cannot be bent into something meaningless', async () => {
    // Only one main company.
    const secondMain = await owner.post('/api/org', { name: 'Another HQ', kind: 'main' });
    assert.equal(secondMain.status, 422);
    assert.match(secondMain.body.error.details.kind, /already exists/i);

    // An SSN cannot hang directly off the main company.
    const main = (await owner.get('/api/org')).body.main;
    const orphan = await owner.post('/api/org', {
      name: 'Floating', kind: 'ssn', parent_id: main.id, share: 30,
    });
    assert.equal(orphan.status, 422);
    assert.match(orphan.body.error.details.parent_id, /under a sub-company/i);

    // An SSN must declare what it keeps.
    const shareless = await owner.post('/api/org', {
      name: 'Shareless', kind: 'ssn', parent_id: worldA.subId,
    });
    assert.equal(shareless.status, 422);
    assert.ok(shareless.body.error.details.share);

    // A share above 100% would send negative money upstream.
    const tooBig = await owner.post('/api/org', {
      name: 'Greedy', kind: 'ssn', parent_id: worldA.subId, share: 140,
    });
    assert.equal(tooBig.status, 422);

    // A sub-company has no share: it passes everything on.
    const subShare = await owner.put(`/api/org/${worldA.subId}`, { share: 25 });
    assert.equal(subShare.status, 422);
    assert.match(subShare.body.error.details.share, /passes everything up/i);

    // A job must declare its tax terms.
    const untaxed = await owner.post('/api/jobs', {
      ssn_id: worldA.ssnId, title: 'Untaxed', joining_date: '2026-08-01',
    });
    assert.equal(untaxed.status, 422, 'the tax terms are required');
    assert.ok(untaxed.body.error.details.tax_hold_bps
      || untaxed.body.error.details.tax_category);
  });
});
