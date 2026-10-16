/**
 * Whole-system smoke test, driven through the HTTP API exactly as the browser
 * does, against a RUNNING instance.
 *
 * `npm test` covers the engine and the permission model in depth against
 * throwaway databases. This script answers a different question: is a real
 * deployed instance, with its real database and its real session handling,
 * actually working end to end?
 *
 * It writes records and toggles the delete setting, so run it against a
 * throwaway database -- never a real one:
 *
 *   DATABASE_PATH=/tmp/check.db OWNER_PASSWORD='a-long-passphrase' npm run seed
 *   DATABASE_PATH=/tmp/check.db PORT=4370 OWNER_PASSWORD='a-long-passphrase' npm start
 *   BASE=http://127.0.0.1:4370 OWNER_EMAIL=owner@example.com \
 *     OWNER_PASSWORD='a-long-passphrase' npm run test:system
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:4370';
const OWNER = {
  email: process.env.OWNER_EMAIL ?? 'owner@example.com',
  password: process.env.OWNER_PASSWORD ?? 'TestPassphrase12345',
};

let cookie = '';
let csrf = '';
const results = [];

const req = async (method, path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [name] = pair.split('=');
    const existing = cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`));
    cookie = [...existing, pair].join('; ');
    if (name.toLowerCase().includes('csrf')) csrf = decodeURIComponent(pair.split('=')[1]);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);
const put = (p, b) => req('PUT', p, b);
const del = (p, b) => req('DELETE', p, b);

const check = (area, name, ok, detail = '') => {
  results.push({ area, name, ok: Boolean(ok), detail });
};
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

/* ------------------------------------------------------------------ run -- */

// 1. The instance is up.
const health = await get('/api/health');
check('Service', 'the server answers', health.status === 200 && health.body?.ok === true,
  `status ${health.status}`);
if (health.status !== 200) {
  console.log(`\nNothing is listening on ${BASE}. Start an instance first.`);
  process.exit(1);
}

const page = await get('/');
check('Service', 'the application shell is served', page.status === 200);

// 2. Authentication.
const bad = await post('/api/auth/login', { email: OWNER.email, password: 'wrong-password' });
check('Auth', 'a wrong password is refused', bad.status === 401,
  `status ${bad.status}`);

const login = await post('/api/auth/login', OWNER);
check('Auth', 'the owner can sign in', login.status === 200,
  login.status === 200 ? login.body.user.email : JSON.stringify(login.body));
if (login.status !== 200) {
  console.log('\nCannot sign in; set OWNER_EMAIL and OWNER_PASSWORD. Stopping.');
  process.exit(1);
}

const session = await get('/api/auth/session');
check('Auth', 'the session is readable and carries permissions',
  session.status === 200 && (session.body.permissions ?? []).length > 0);

// A cookie-only request with no CSRF token must not be able to write.
const noCsrf = await fetch(`${BASE}/api/org`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ name: 'csrf attempt', kind: 'main' }),
});
check('Auth', 'a write without the CSRF token is refused',
  noCsrf.status === 401 || noCsrf.status === 403, `status ${noCsrf.status}`);

// 3. The company structure.
const tree = await get('/api/org');
check('Structure', 'the company tree loads', tree.status === 200);
check('Structure', 'a main company exists', Boolean(tree.body?.main),
  tree.body?.main?.name ?? 'none -- create one in Structure first');

const ssns = (await get('/api/org/meta/ssns')).body?.rows ?? [];
check('Structure', 'at least one SSN exists', ssns.length > 0,
  ssns.map((d) => `${d.sub_name}/${d.name}`).join(', ') || 'none');
if (!ssns.length) {
  console.log('\nNo SSNs to test against. Run `npm run seed` first. Stopping.');
  process.exit(1);
}

const ssn = ssns[0];
const categories = (await get('/api/expenses/meta/categories')).body?.rows ?? [];
check('Structure', 'expense categories exist', categories.length > 0);

// An SSN must sit under a sub-company, never under the main company.
const orphan = await post('/api/org', {
  name: `Floating ${Date.now()}`, kind: 'ssn',
  parent_id: tree.body.main.id, share: 30,
});
check('Structure', 'an SSN cannot hang off the main company',
  orphan.status === 422, `status ${orphan.status}`);

const secondMain = await post('/api/org', { name: `HQ ${Date.now()}`, kind: 'main' });
check('Structure', 'only one main company is allowed', secondMain.status === 422,
  `status ${secondMain.status}`);

// 4. The waterfall, computed on a month of our own so we know the answer.
const MONTH = '2027-03';
const job = await post('/api/jobs', {
  ssn_id: ssn.id, title: 'System test job', client_name: 'System Test Co',
  tax_category: 'w2', tax_hold: 10, joining_date: `${MONTH}-01`,
});
check('Jobs', 'a job can be set up', job.status === 201,
  job.status === 201 ? job.body.job.reference : JSON.stringify(job.body));

const salary = await post('/api/salaries', {
  job_id: job.body?.job?.id,
  accounting_month: MONTH,
  invoice_amount: '10000.00',
  credited_amount: '8000.00',
  credit_date: `${MONTH}-15`,
});
check('Salaries', 'a salary can be recorded against it', salary.status === 201,
  salary.status === 201 ? salary.body.salary.reference : JSON.stringify(salary.body));

const overCredited = await post('/api/salaries', {
  job_id: job.body?.job?.id, accounting_month: MONTH,
  invoice_amount: '100.00', credited_amount: '500.00',
});
check('Salaries', 'more cannot be credited than was invoiced',
  overCredited.status === 422, `status ${overCredited.status}`);

const expense = await post('/api/expenses', {
  ssn_id: ssn.id, accounting_month: MONTH, expense_date: `${MONTH}-12`,
  amount: '2000.00', category_id: categories[0].id, description: 'System test expense',
});
check('Expenses', 'an expense can be charged to an SSN', expense.status === 201,
  expense.status === 201 ? expense.body.expense.reference : JSON.stringify(expense.body));

const statement = (await get(`/api/org/${ssn.id}/statement?month=${MONTH}`)).body?.statement;
// 10,000 invoiced, 8,000 credited -> 2,000 withheld. 10% of 8,000 is 800 held,
// leaving 7,200 for the SSN, less 2,000 of expenses.
const expectedKeep = Math.trunc((720000 - 200000) * ssn.share_bps / 10000);

check('Engine', 'invoiced is what was billed', statement?.invoice_cents === 1000000,
  money(statement?.invoice_cents));
check('Engine', 'the withheld amount is invoice less credited',
  statement?.withheld_cents === 200000, money(statement?.withheld_cents));
check('Engine', "the hold is the job's rate on the credited amount",
  statement?.tax_hold_cents === 80000, `${money(statement?.tax_hold_cents)} — 10% of 8,000`);
check('Engine', 'what reached the SSN is credited less the hold',
  statement?.salary_cents === 720000, money(statement?.salary_cents));
check('Engine', 'expenses come off the SSN total',
  statement?.distributable_cents === 520000, money(statement?.distributable_cents));
check('Engine', 'what is kept is the SSN share of what remains',
  statement?.keep_cents === expectedKeep,
  `${money(statement?.keep_cents)} at ${ssn.share_bps / 100}%`);
check('Engine', 'kept plus upstream reconciles to what remains exactly',
  statement && statement.keep_cents + statement.upstream_cents === statement.distributable_cents,
  `${money(statement?.keep_cents)} + ${money(statement?.upstream_cents)} = `
  + money(statement?.distributable_cents));

const lines = (await get(`/api/org/${ssn.id}/statement?month=${MONTH}`)).body?.salaries ?? [];
check('Engine', 'the statement lists the salary lines its totals came from',
  lines.length === 1 && lines[0].to_ssn_cents === 720000,
  `${lines.length} line(s)`);

// 5. A tax override replaces the rate for that month only.
const override = await put('/api/tax/overrides', {
  ssn_id: ssn.id, accounting_month: MONTH, amount: '1234.00',
  reason: 'System test override',
});
check('Tax', 'a month\'s tax hold can be overridden', override.status === 200,
  `status ${override.status}`);
const overridden = (await get(`/api/org/${ssn.id}/statement?month=${MONTH}`)).body?.statement;
check('Tax', 'the override is what the statement uses',
  overridden?.tax_hold_cents === 123400 && overridden?.tax_basis === 'override',
  `${money(overridden?.tax_hold_cents)} (${overridden?.tax_basis})`);

// 6. The roll-up agrees with the statements it is built from.
const dashboard = (await get(`/api/dashboard?month=${MONTH}`)).body;
const dashRow = dashboard?.ssns?.find((d) => d.ssn_id === ssn.id);
check('Roll-up', 'the dashboard agrees with the statement',
  dashRow?.upstream_cents === overridden?.upstream_cents,
  `${money(dashRow?.upstream_cents)} vs ${money(overridden?.upstream_cents)}`);

const summed = (dashboard?.ssns ?? []).reduce((acc, d) => acc + d.upstream_cents, 0);
check('Roll-up', 'the main company total is the sum of every upstream amount',
  dashboard?.rollup?.total_received_cents === summed,
  `${money(dashboard?.rollup?.total_received_cents)} vs ${money(summed)}`);

const subsTotal = (dashboard?.rollup?.sub_companies ?? [])
  .reduce((acc, s) => acc + s.passed_up_cents, 0);
check('Roll-up', 'and equals what the sub-companies passed on',
  dashboard?.rollup?.total_received_cents === subsTotal);
check('Roll-up', 'every sub-company keeps nothing',
  (dashboard?.rollup?.sub_companies ?? []).every((s) => s.kept_cents === 0));

// 7. Reports and exports.
const report = await get(`/api/reports/month?month=${MONTH}`);
check('Reports', 'the month report loads and states its basis',
  report.status === 200 && Boolean(report.body?.basis?.title));

const csv = await get(`/api/reports/export/month?month=${MONTH}&format=csv`);
check('Reports', 'the month export returns a CSV',
  csv.status === 200 && /SSN/.test(csv.text), `status ${csv.status}`);

const xlsx = await get(`/api/reports/export/month?month=${MONTH}&format=xlsx`);
check('Reports', 'the month export returns a spreadsheet',
  xlsx.status === 200
  && (xlsx.headers.get('content-type') ?? '').includes('spreadsheetml'),
  `status ${xlsx.status}`);

const ssnCsv = await get(`/api/reports/export/ssn/${ssn.id}?format=csv`);
check('Reports', 'the SSN export returns a CSV', ssnCsv.status === 200);

const auditCsv = await get('/api/reports/audit-history?format=csv');
check('Reports', 'the audit history exports', auditCsv.status === 200);

// 8. The delete gate.
await put('/api/settings', { allow_delete: 'false' });
const refused = await del(`/api/salaries/${salary.body.salary.id}`, { reason: 'system test' });
check('Deleting', 'deleting is refused while the setting is off',
  refused.status === 403 && /switched off/i.test(refused.body?.error?.message ?? ''),
  refused.body?.error?.message?.slice(0, 60) ?? `status ${refused.status}`);

await put('/api/settings', { allow_delete: 'true' });
const noReason = await del(`/api/salaries/${salary.body.salary.id}`);
check('Deleting', 'a reason is required even once deleting is allowed',
  noReason.status === 400, `status ${noReason.status}`);

const deleted = await del(`/api/salaries/${salary.body.salary.id}`,
  { reason: 'system test cleanup' });
check('Deleting', 'a salary can then be deleted', deleted.status === 200);

const protectedSsn = await del(`/api/org/${ssn.id}`);
check('Deleting', 'an SSN with history cannot be deleted',
  protectedSsn.status === 409, `status ${protectedSsn.status}`);
await put('/api/settings', { allow_delete: 'false' });

// 9. The audit trail recorded all of it.
const audit = await get('/api/audit?entity_type=salary');
check('Audit', 'salary changes are in the audit history',
  audit.status === 200 && (audit.body?.rows ?? []).length > 0);
check('Audit', 'the deletion is recorded with its reason',
  (audit.body?.rows ?? []).some((r) => r.action === 'deleted'
    && /system test cleanup/.test(r.reason ?? '')));

// 10. Clean up what we recorded, so the instance is left as we found it.
await put('/api/settings', { allow_delete: 'true' });
await del(`/api/expenses/${expense.body?.expense?.id}`, { reason: 'system test cleanup' });
await del(`/api/jobs/${job.body?.job?.id}`, { reason: 'system test cleanup' });
const overrides = await get(`/api/tax/overrides?ssn_id=${ssn.id}&month=${MONTH}`);
for (const row of overrides.body?.rows ?? []) await del(`/api/tax/overrides/${row.id}`);
await put('/api/settings', { allow_delete: 'false' });

const leftover = (await get(`/api/org/${ssn.id}/statement?month=${MONTH}`)).body?.statement;
check('Cleanup', 'the test month is empty again',
  leftover?.credited_cents === 0 && leftover?.expense_cents === 0,
  `${money(leftover?.credited_cents)} credited, ${money(leftover?.expense_cents)} expenses`);

/* -------------------------------------------------------------- report -- */

const areas = [...new Set(results.map((r) => r.area))];
let failed = 0;
for (const area of areas) {
  console.log(`\n${area}`);
  for (const r of results.filter((x) => x.area === area)) {
    if (!r.ok) failed += 1;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n          ${r.detail}` : ''}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
