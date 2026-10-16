/**
 * The flow, end to end.
 *
 * A JOB is an engagement under an SSN: a tax category, a tax-hold percentage,
 * a joining date. It holds no money. A SALARY is one month's money on a job --
 * an invoice amount and the amount actually credited.
 *
 * Per salary:   credited - the job's hold % of credited = to the SSN
 *               invoice - credited = withheld by the hiring company
 * Per month:    sum of that - the SSN's expenses = remaining
 * Then:         the SSN keeps its share, the rest goes up the tree.
 *
 * Test 1 is the worked example from the specification and is quoted in the
 * README and the seed: 1,000 invoiced, 800 credited (200 withheld), a 10%
 * hold taking 80, leaving 720 for the SSN.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, shutdown, ownerClient, makeWorld, addJob, addSalary, addJobWithSalary,
  addExpense, overrideTax, statement, cents, rollup, makeUser,
} from './helpers.js';

let client;

before(async () => {
  await boot();
  client = await ownerClient();
});
after(shutdown);

const MONTH = '2026-10';

describe('a salary', () => {
  test('1. the worked example: 1,000 invoiced, 800 credited, 10% hold', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const created = await addJobWithSalary(client, world, {
      month: MONTH, invoice: '1000.00', credited: '800.00', taxPercent: 10, category: 'w2',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.invoice_cents, cents('1000'), 'what was billed');
    assert.equal(s.credited_cents, cents('800'), 'what arrived');
    assert.equal(s.withheld_cents, cents('200'), 'the company kept 200 under W2');
    assert.equal(s.tax_hold_cents, cents('80'), '10% of the 800 credited, not of the invoice');
    assert.equal(s.salary_cents, cents('720'), 'what reached the SSN');
  });

  test('2. the withheld amount is never deducted from the SSN twice', async () => {
    /*
     * The 200 the company kept never reached the SSN, so the SSN's figure must
     * start from the 800 credited. Deducting the withheld amount again would
     * leave 520 instead of 720.
     */
    const world = await makeWorld(client, { shareBps: 10000 });
    await addJobWithSalary(client, world, {
      month: MONTH, invoice: '1000.00', credited: '800.00', taxPercent: 10,
    });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.salary_cents, cents('720'));
    assert.equal(
      s.salary_cents, s.credited_cents - s.tax_hold_cents,
      'the SSN figure is credited less the hold, and nothing else'
    );
    assert.equal(s.distributable_cents, cents('720'), 'no expenses, so it all remains');
    assert.equal(s.keep_cents, cents('720'), 'a 100% share keeps all of it');
  });

  test('3. a 1099 job with nothing withheld credits the invoice in full', async () => {
    const world = await makeWorld(client, { shareBps: 5000 });
    await addJobWithSalary(client, world, {
      month: MONTH, invoice: '2000.00', taxPercent: 10, category: '1099',
    });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.invoice_cents, cents('2000'));
    assert.equal(s.credited_cents, cents('2000'));
    assert.equal(s.withheld_cents, 0, 'nothing withheld');
    assert.equal(s.tax_hold_cents, cents('200'));
    assert.equal(s.salary_cents, cents('1800'));
  });

  test('4. more cannot be credited than was invoiced', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 10 });
    const refused = await addSalary(client, {
      jobId: job.id, month: MONTH, invoice: '500.00', credited: '900.00',
    });
    assert.equal(refused.status, 422, 'the withheld amount would go negative');
    assert.ok(refused.body.error.details.credited_amount);
  });

  test('5. one job pays many months, each on its own', async () => {
    const world = await makeWorld(client, { shareBps: 5000 });
    const job = await addJob(client, world, { taxPercent: 10, title: 'Retainer' });

    await addSalary(client, { jobId: job.id, month: '2026-10', invoice: '1000.00', credited: '800.00' });
    await addSalary(client, { jobId: job.id, month: '2026-11', invoice: '1000.00', credited: '1000.00' });

    const october = (await statement(client, world, '2026-10')).body.statement;
    const november = (await statement(client, world, '2026-11')).body.statement;

    assert.equal(october.salary_cents, cents('720'), '800 credited less 80 held');
    assert.equal(november.salary_cents, cents('900'), '1,000 credited less 100 held');
    assert.equal(october.job_count, 1);
    assert.equal(november.job_count, 1, 'the same job, a different month');
  });

  test('6. several salaries in one month are each held on their own', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    // Two jobs under one SSN, taxed differently, each truncating on its own:
    //   1.05 at 50% -> 52.5 -> 52
    //   1.05 at 50% -> 52.5 -> 52
    // 104 together, where 50% of the 210 total would be 105.
    const a = await addJob(client, world, { taxPercent: 50, title: 'A' });
    const b = await addJob(client, world, { taxPercent: 50, title: 'B' });
    await addSalary(client, { jobId: a.id, month: MONTH, invoice: '1.05' });
    await addSalary(client, { jobId: b.id, month: MONTH, invoice: '1.05' });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.credited_cents, 210);
    assert.equal(s.tax_hold_cents, 104, 'each salary truncated on its own, then summed');
    assert.equal(s.job_count, 2);
    assert.equal(s.salary_count, 2);
  });

  test('7. only active salaries count', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 10 });
    await addSalary(client, { jobId: job.id, month: MONTH, invoice: '1000.00' });
    await addSalary(client, { jobId: job.id, month: MONTH, invoice: '500.00', status: 'draft' });
    await addSalary(client, { jobId: job.id, month: MONTH, invoice: '700.00', status: 'void' });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.credited_cents, cents('1000'), 'draft and void salaries are not money');
    assert.equal(s.tax_hold_cents, cents('100'), 'and carry no hold');
    assert.equal(s.salary_count, 1);
  });

  test('8. an inactive job takes no new salary but keeps the ones it has', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 10 });
    await addSalary(client, { jobId: job.id, month: MONTH, invoice: '1000.00' });

    const ended = await client.put(`/api/jobs/${job.id}`, { is_active: false });
    assert.equal(ended.status, 200);

    const refused = await addSalary(client, { jobId: job.id, month: '2026-11', invoice: '1000.00' });
    assert.equal(refused.status, 422, 'an inactive job is closed to new salaries');

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.credited_cents, cents('1000'),
      'but the salary already recorded still counts');
  });

  test('5b. the pay period is optional, descriptive, and may straddle a month', async () => {
    const world = await makeWorld(client, { shareBps: 5000 });
    const job = await addJob(client, world, { taxPercent: 10 });

    // Recorded without one at all.
    const bare = await addSalary(client, { jobId: job.id, month: MONTH, invoice: '1000.00' });
    assert.equal(bare.status, 201);
    assert.equal(bare.body.salary.pay_period_from, null);
    assert.equal(bare.body.salary.pay_period_to, null);

    // And with one that runs from September into October, which is the whole
    // point of keeping it separate from the accounting month.
    const withPeriod = await addSalary(client, {
      jobId: job.id, month: MONTH, invoice: '500.00',
      periodFrom: '2026-09-21', periodTo: '2026-10-05',
    });
    assert.equal(withPeriod.status, 201, JSON.stringify(withPeriod.body));
    assert.equal(withPeriod.body.salary.pay_period_from, '2026-09-21');
    assert.equal(withPeriod.body.salary.pay_period_to, '2026-10-05');

    // The period changes no figure: it is descriptive only.
    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.credited_cents, cents('1500'), 'both salaries counted in October');
    assert.equal(s.tax_hold_cents, cents('150'));

    const september = (await statement(client, world, '2026-09')).body.statement;
    assert.equal(september.credited_cents, 0,
      'the period reaching into September does not move money there');

    // Backwards is refused.
    const inverted = await addSalary(client, {
      jobId: job.id, month: MONTH, invoice: '100.00',
      periodFrom: '2026-10-20', periodTo: '2026-10-01',
    });
    assert.equal(inverted.status, 422, 'a period cannot end before it starts');
    assert.ok(inverted.body.error.details.pay_period_to);

    // One end alone is allowed: an open-ended period is a real thing.
    const openEnded = await addSalary(client, {
      jobId: job.id, month: MONTH, invoice: '100.00', periodFrom: '2026-10-01',
    });
    assert.equal(openEnded.status, 201);
    assert.equal(openEnded.body.salary.pay_period_to, null);
  });

  test('5c. salaries can be filtered by overlapping pay period', async () => {
    const world = await makeWorld(client, { shareBps: 5000 });
    const job = await addJob(client, world, { taxPercent: 0, title: 'Period filter' });
    await addSalary(client, {
      jobId: job.id, month: MONTH, invoice: '111.00',
      periodFrom: '2026-09-21', periodTo: '2026-10-05',
    });

    // A search over early October must find a period that STARTED in September:
    // overlap, not containment.
    const overlapping = await client.get(
      `/api/salaries?job_id=${job.id}&period_from=2026-10-01&period_to=2026-10-10`);
    assert.equal(overlapping.status, 200);
    assert.equal(overlapping.body.rows.length, 1, 'the straddling period is found');

    const outside = await client.get(
      `/api/salaries?job_id=${job.id}&period_from=2026-11-01&period_to=2026-11-30`);
    assert.equal(outside.body.rows.length, 0, 'a range it does not touch finds nothing');
  });
});

describe('the SSN month', () => {
  test('9. expenses come off the SSN total, not off a single salary', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    // Two jobs: 800 credited at 10% -> 720, and 2,000 credited at 10% -> 1,800.
    await addJobWithSalary(client, world, {
      month: MONTH, invoice: '1000.00', credited: '800.00', taxPercent: 10, title: 'One',
    });
    await addJobWithSalary(client, world, {
      month: MONTH, invoice: '2000.00', taxPercent: 10, title: 'Two',
    });
    await addExpense(client, world, { month: MONTH, amount: '520.00' });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.salary_cents, cents('2520'), '720 + 1,800 reached the SSN');
    assert.equal(s.expense_cents, cents('520'));
    assert.equal(s.distributable_cents, cents('2000'), 'then the expenses come off');
    assert.equal(s.keep_cents, cents('600'), '30% of 2,000');
    assert.equal(s.upstream_cents, cents('1400'), 'and 70% goes up');
  });

  test('10. what is kept and what goes up reconcile to the cent', async () => {
    const world = await makeWorld(client, { shareBps: 3333 });
    await addJobWithSalary(client, world, {
      month: MONTH, invoice: '1000.01', taxPercent: 0,
    });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.distributable_cents, cents('1000.01'));
    assert.equal(s.keep_cents + s.upstream_cents, s.distributable_cents);
    assert.equal(s.keep_cents, 33330, '100001 * 3333 / 10000, truncated');
    assert.equal(s.upstream_cents, 100001 - 33330);
  });

  test('11. a tax override replaces the computed total for that month only', async () => {
    const world = await makeWorld(client, { shareBps: 5000 });
    const job = await addJob(client, world, { taxPercent: 20 });
    await addSalary(client, { jobId: job.id, month: MONTH, invoice: '1000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-11', invoice: '1000.00' });

    const before = (await statement(client, world, MONTH)).body.statement;
    assert.equal(before.tax_hold_cents, cents('200'));
    assert.equal(before.tax_basis, 'per_job');

    await overrideTax(client, world, {
      month: MONTH, amount: '350', reason: 'actual tax bill was higher',
    });

    const after = (await statement(client, world, MONTH)).body.statement;
    assert.equal(after.tax_hold_cents, cents('350'));
    assert.equal(after.tax_basis, 'override');
    assert.equal(after.computed_tax_cents, cents('200'),
      'the salaries still come to 200, which is what makes the override visible');
    assert.equal(after.salary_cents, cents('650'), '1,000 credited less the 350 override');

    const other = (await statement(client, world, '2026-11')).body.statement;
    assert.equal(other.tax_hold_cents, cents('200'), 'other months are untouched');
  });

  test('12. the hold can never exceed what was credited', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    await addJobWithSalary(client, world, { month: MONTH, invoice: '100.00', taxPercent: 10 });

    // An override far larger than the month's credited total.
    await overrideTax(client, world, { month: MONTH, amount: '500', reason: 'clamp check' });
    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.tax_hold_cents, cents('100'), 'clamped to the 100 credited');
    assert.equal(s.salary_cents, 0, 'so nothing reaches the SSN, but nothing goes negative');
  });

  test('13. a loss stays with the SSN and never travels upstream', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    await addJobWithSalary(client, world, { month: MONTH, invoice: '200.00', taxPercent: 0 });
    await addExpense(client, world, { month: MONTH, amount: '900.00' });

    const s = (await statement(client, world, MONTH)).body.statement;
    assert.equal(s.distributable_cents, cents('-700'));
    assert.equal(s.keep_cents, cents('-700'), 'the SSN carries the whole loss');
    assert.equal(s.upstream_cents, 0, 'nothing is sent up, and nothing is demanded back');
  });
});

describe('the roll-up', () => {
  test('14. a sub-company collects its SSNs and passes everything on', async () => {
    const month = '2026-09';
    const world = await makeWorld(client, {
      shareBps: 3000, ssns: [{ name: `Beta ${Date.now()}`, shareBps: 4000 }],
    });
    const betaId = world.extras[0].ssnId;

    // Alpha: 800 credited at 10% -> 720, less 220 expenses -> 500.
    //        keeps 30% = 150, sends 350.
    await addJobWithSalary(client, world, {
      month, invoice: '1000.00', credited: '800.00', taxPercent: 10,
    });
    await addExpense(client, world, { month, amount: '220.00' });
    // Beta: 1,000 credited at 10% -> 900, less 100 expenses -> 800.
    //       keeps 40% = 320, sends 480.
    await addJobWithSalary(client, world, {
      month, invoice: '1000.00', taxPercent: 10, ssnId: betaId,
    });
    await addExpense(client, world, { month, amount: '100.00', ssnId: betaId });

    const alpha = (await statement(client, world, month)).body.statement;
    const beta = (await statement(client, world, month, betaId)).body.statement;
    assert.equal(alpha.upstream_cents, cents('350'));
    assert.equal(beta.upstream_cents, cents('480'));

    const sub = rollup.subMonth(world.subId, month);
    assert.equal(sub.collected_cents, cents('830'), '350 + 480');
    assert.equal(sub.kept_cents, 0, 'a sub-company keeps nothing');
    assert.equal(sub.passed_up_cents, sub.collected_cents);
    assert.equal(sub.withheld_cents, cents('200'), 'the W2 cut is visible at this level too');
  });

  test('15. the main company receives the sum of every SSN\'s upstream amount', async () => {
    const month = '2026-08';
    const world = await makeWorld(client, { shareBps: 2500 });
    await addJobWithSalary(client, world, { month, invoice: '4000.00', taxPercent: 10 });

    const second = await makeWorld(client, { shareBps: 5000 });
    await addJobWithSalary(client, second, { month, invoice: '1000.00', taxPercent: 0 });

    const main = rollup.mainMonth(month);
    const expected = rollup.allSsnMonths(month).reduce((acc, d) => acc + d.upstream_cents, 0);

    assert.equal(main.total_received_cents, expected);
    assert.equal(
      main.total_received_cents,
      main.sub_companies.reduce((acc, s) => acc + s.passed_up_cents, 0)
    );
    assert.equal(
      main.distributable_cents,
      main.ssn_kept_cents + main.total_received_cents,
      'what remains splits entirely into kept-by-SSNs plus received-by-main'
    );
  });

  test('15b. the dashboard totals a month range, and the range equals its parts', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 10, title: 'Range job' });
    await addSalary(client, { jobId: job.id, month: '2026-04', invoice: '1000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-05', invoice: '2000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-06', invoice: '3000.00' });
    await addExpense(client, world, { month: '2026-05', amount: '100.00' });

    const april = (await statement(client, world, '2026-04')).body.statement;
    const may = (await statement(client, world, '2026-05')).body.statement;
    const june = (await statement(client, world, '2026-06')).body.statement;

    const range = await client.get(
      `/api/dashboard?month_from=2026-04&month_to=2026-06&ssn_id=${world.ssnId}`);
    assert.equal(range.status, 200, JSON.stringify(range.body));
    assert.equal(range.body.range.months, 3, 'three months covered');
    assert.equal(range.body.range.from, '2026-04-01');
    assert.equal(range.body.range.to, '2026-06-01');

    const row = range.body.ssns.find((r) => r.ssn_id === world.ssnId);
    for (const key of ['credited_cents', 'tax_hold_cents', 'salary_cents',
      'expense_cents', 'keep_cents', 'upstream_cents']) {
      assert.equal(row[key], april[key] + may[key] + june[key],
        `${key} across the range is the sum of the three months`);
    }
    assert.equal(row.salary_count, 3, 'three salaries');
    assert.equal(row.job_count, 1,
      'one DISTINCT job, not one per month it paid into');
    assert.equal(range.body.trend.length, 3, 'a trend point per month');
  });

  test('15c. the dashboard can be narrowed to one SSN or one sub-company', async () => {
    const month = '2026-03';
    const world = await makeWorld(client, {
      shareBps: 3000, ssns: [{ name: `Sibling ${Date.now()}`, shareBps: 5000 }],
    });
    const siblingId = world.extras[0].ssnId;
    await addJobWithSalary(client, world, { month, invoice: '1000.00', taxPercent: 0 });
    await addJobWithSalary(client, world, {
      month, invoice: '4000.00', taxPercent: 0, ssnId: siblingId,
    });

    // The sub-company holds both.
    const bySub = await client.get(
      `/api/dashboard?month=${month}&sub_id=${world.subId}`);
    assert.equal(bySub.status, 200);
    assert.equal(bySub.body.ssns.length, 2, 'both SSNs under that sub-company');
    assert.equal(bySub.body.rollup.credited_cents, cents('5000'));
    assert.equal(bySub.body.filters.sub_name, bySub.body.ssns[0].sub_name);

    // One SSN alone.
    const bySsn = await client.get(`/api/dashboard?month=${month}&ssn_id=${world.ssnId}`);
    assert.equal(bySsn.body.ssns.length, 1);
    assert.equal(bySsn.body.rollup.credited_cents, cents('1000'),
      'only that SSN counts toward the headline');
    assert.equal(
      bySsn.body.rollup.total_received_cents, bySsn.body.ssns[0].upstream_cents,
      'and the main company figure narrows with it'
    );

    // An id that is not an SSN, or does not exist, is refused rather than
    // silently ignored -- a filter that quietly does nothing is worse than one
    // that complains.
    const wrongKind = await client.get(`/api/dashboard?ssn_id=${world.subId}`);
    assert.equal(wrongKind.status, 422);
    const missing = await client.get('/api/dashboard?sub_id=999999');
    assert.equal(missing.status, 422);

    // And a backwards range says so.
    const backwards = await client.get('/api/dashboard?month_from=2026-06&month_to=2026-01');
    assert.equal(backwards.status, 422);
    assert.ok(backwards.body.error.details.month_from);
  });

  test('15e. a date range is answered in the whole months it touches', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 0, title: 'Dated job' });
    await addSalary(client, { jobId: job.id, month: '2026-01', invoice: '1000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-02', invoice: '2000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-03', invoice: '4000.00' });

    /*
     * Dates that start and end mid-month. Every month they touch comes back
     * whole: this system accounts by month, so half of February has no total.
     */
    const span = await client.get(
      `/api/dashboard?date_from=2026-01-20&date_to=2026-03-04&ssn_id=${world.ssnId}`);
    assert.equal(span.status, 200, JSON.stringify(span.body));
    assert.equal(span.body.range.basis, 'dates');
    assert.equal(span.body.range.from, '2026-01-01', 'back to the start of January');
    assert.equal(span.body.range.to, '2026-03-01', 'forward to all of March');
    assert.equal(span.body.range.months, 3);
    assert.equal(span.body.range.date_from, '2026-01-20', 'the dates asked for come back');
    assert.equal(span.body.range.date_to, '2026-03-04');
    assert.equal(span.body.ssns[0].credited_cents, cents('7000'),
      'all three months in full, not a pro-rated slice');

    // One date alone is an open end, bounded by what has been recorded.
    const openEnd = await client.get(
      `/api/dashboard?date_from=2026-02-11&ssn_id=${world.ssnId}`);
    assert.equal(openEnd.body.range.from, '2026-02-01');
    assert.ok(openEnd.body.range.to >= '2026-03-01', 'runs to the latest active month');

    // A single month is still its own question.
    const single = await client.get(`/api/dashboard?month=2026-02&ssn_id=${world.ssnId}`);
    assert.equal(single.body.range.basis, 'month');
    assert.equal(single.body.range.months, 1);
    assert.equal(single.body.ssns[0].credited_cents, cents('2000'));

    // The two ways of asking are mutually exclusive: a request carrying both
    // has two answers in it, so it is refused rather than resolved by
    // precedence.
    const both = await client.get('/api/dashboard?month=2026-02&date_from=2026-01-01');
    assert.equal(both.status, 422);
    assert.ok(both.body.error.details.month);

    const backwards = await client.get('/api/dashboard?date_from=2026-03-01&date_to=2026-01-01');
    assert.equal(backwards.status, 422);
    assert.ok(backwards.body.error.details.date_from);

    // A typo must not quietly widen the range to everything.
    const nonsense = await client.get('/api/dashboard?date_from=2026-02-30');
    assert.equal(nonsense.status, 422, 'February 30th is not a date');

    // The Tax Hold page reads the same filters, so the same question put to
    // either page covers the same months.
    const tax = await client.get(
      `/api/tax?date_from=2026-01-20&date_to=2026-03-04&ssn_id=${world.ssnId}`);
    assert.equal(tax.status, 200);
    assert.equal(tax.body.range.basis, 'dates');
    assert.equal(tax.body.range.months, 3);
    assert.equal(tax.body.rows[0].credited_cents, cents('7000'),
      'and totals the same money the dashboard did');
    const taxBoth = await client.get('/api/tax?month=2026-02&date_to=2026-03-04');
    assert.equal(taxBoth.status, 422);
  });

  test('15d. the Tax Hold page is tax-only, ranged, and filterable', async () => {
    const world = await makeWorld(client, { shareBps: 3000 });
    const job = await addJob(client, world, { taxPercent: 10, title: 'Taxed job' });
    await addSalary(client, { jobId: job.id, month: '2026-04', invoice: '1000.00' });
    await addSalary(client, { jobId: job.id, month: '2026-05', invoice: '2000.00' });
    // An expense, to prove it does NOT appear in a tax figure.
    await addExpense(client, world, { month: '2026-04', amount: '750.00' });

    const single = await client.get(`/api/tax?month=2026-04&ssn_id=${world.ssnId}`);
    assert.equal(single.status, 200, JSON.stringify(single.body));
    const row = single.body.rows[0];
    assert.equal(row.credited_cents, cents('1000'), 'the amount the hold comes out of');
    assert.equal(row.computed_tax_cents, cents('100'), '10% of it');
    assert.equal(row.tax_hold_cents, cents('100'), 'and nothing overrode that');
    assert.equal(row.effective_bps, 1000, 'so the effective rate is 10%');
    assert.equal(row.override_months, 0);
    // Tax only: the page must not be carrying income or expense figures.
    for (const gone of ['expense_cents', 'salary_cents', 'distributable_cents',
      'keep_cents', 'upstream_cents', 'invoice_cents']) {
      assert.equal(row[gone], undefined, `${gone} does not belong on a tax page`);
    }

    // A range totals its months.
    const ranged = await client.get(
      `/api/tax?month_from=2026-04&month_to=2026-05&ssn_id=${world.ssnId}`);
    assert.equal(ranged.body.range.months, 2);
    assert.equal(ranged.body.totals.tax_hold_cents, cents('300'), '100 + 200');
    assert.equal(ranged.body.trend.length, 2, 'a trend point per month');

    // An override shows as a delta against the job rates, in that month only.
    await overrideTax(client, world, {
      month: '2026-05', amount: '350', reason: 'real bill was higher',
    });
    const after = await client.get(`/api/tax?month=2026-05&ssn_id=${world.ssnId}`);
    const overridden = after.body.rows[0];
    assert.equal(overridden.computed_tax_cents, cents('200'), 'the jobs still say 200');
    assert.equal(overridden.tax_hold_cents, cents('350'), 'but 350 was held');
    assert.equal(overridden.override_delta_cents, cents('150'), 'a +150 move');
    assert.equal(overridden.override_months, 1);

    // The basis filter splits the set, and the two halves add back to the whole.
    const all = await client.get('/api/tax?month_from=2026-04&month_to=2026-05');
    const over = await client.get('/api/tax?month_from=2026-04&month_to=2026-05&basis=override');
    const plain = await client.get('/api/tax?month_from=2026-04&month_to=2026-05&basis=per_job');
    assert.equal(over.body.rows.length + plain.body.rows.length, all.body.rows.length);
    assert.equal(
      over.body.totals.tax_hold_cents + plain.body.totals.tax_hold_cents,
      all.body.totals.tax_hold_cents,
      'the filtered halves reconcile with the unfiltered total'
    );
    assert.ok(over.body.rows.every((r) => r.override_months > 0));
    assert.ok(plain.body.rows.every((r) => r.override_months === 0));

    const badBasis = await client.get('/api/tax?basis=nonsense');
    assert.equal(badBasis.status, 422);
  });

  test('16. the dashboard, the statement and the report agree', async () => {
    const month = '2026-07';
    const world = await makeWorld(client, { shareBps: 3500 });
    await addJobWithSalary(client, world, {
      month, invoice: '6000.00', credited: '5000.00', taxPercent: 12,
    });
    await addExpense(client, world, { month, amount: '1500.00' });

    const fromStatement = (await statement(client, world, month)).body.statement;

    const dashboard = await client.get(`/api/dashboard?month=${month}`);
    const dashRow = dashboard.body.ssns.find((d) => d.ssn_id === world.ssnId);

    const report = await client.get(`/api/reports/month?month=${month}`);
    const reportRow = report.body.rows.find((r) => r.ssn_id === world.ssnId);

    for (const key of ['invoice_cents', 'credited_cents', 'withheld_cents', 'tax_hold_cents',
      'salary_cents', 'expense_cents', 'distributable_cents', 'keep_cents', 'upstream_cents']) {
      assert.equal(dashRow[key], fromStatement[key], `dashboard ${key} matches the statement`);
      assert.equal(reportRow[key], fromStatement[key], `report ${key} matches the statement`);
    }
  });

  test('16b. a statement downloads as a PDF', async () => {
    const month = '2026-02';
    const world = await makeWorld(client, { shareBps: 3000 });
    await addJobWithSalary(client, world, {
      month, invoice: '2000.00', credited: '1600.00', taxPercent: 10, title: 'PDF job',
    });
    await addExpense(client, world, { month, amount: '400.00' });

    const pdf = await client.get(
      `/api/reports/export/statement/${world.ssnId}?month=${month}`);
    assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
    assert.match(pdf.headers.get('content-type') ?? '', /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition') ?? '', /attachment/);
    assert.match(pdf.headers.get('content-disposition') ?? '', /\.pdf/);
    // A real document, not an error page that happens to be 200.
    assert.ok(pdf.text.startsWith('%PDF'), 'the body is a PDF');
    assert.ok(pdf.text.length > 1000, 'and has some substance to it');

    // A month with nothing in it still renders rather than throwing: an empty
    // statement is the harder layout case.
    const empty = await client.get(
      `/api/reports/export/statement/${world.ssnId}?month=2026-01`);
    assert.equal(empty.status, 200);
    assert.ok(empty.text.startsWith('%PDF'));

    // Gated on reports.export, and on scope.
    const noExport = await makeUser(client, {
      role: 'viewer', permissions: [{ permission: 'reports.export', effect: 'deny' }],
    });
    const refused = await noExport.client.get(
      `/api/reports/export/statement/${world.ssnId}?month=${month}`);
    assert.equal(refused.status, 403, 'exporting is a permission of its own');

    const other = await makeWorld(client, { shareBps: 5000 });
    const scoped = await makeUser(client, {
      role: 'editor', scopes: [{ scope_type: 'org_unit', scope_id: other.ssnId }],
    });
    const foreign = await scoped.client.get(
      `/api/reports/export/statement/${world.ssnId}?month=${month}`);
    assert.equal(foreign.status, 404, "another SSN's statement is not downloadable");
  });

  test('17. the statement lists the salary lines its totals were summed from', async () => {
    const month = '2026-06';
    const world = await makeWorld(client, { shareBps: 3000 });
    await addJobWithSalary(client, world, {
      month, invoice: '1000.00', credited: '800.00', taxPercent: 10, title: 'One',
    });
    await addJobWithSalary(client, world, {
      month, invoice: '2000.00', credited: '1500.00', taxPercent: 10, title: 'Two',
    });

    const result = await statement(client, world, month);
    const { statement: s, salaries } = result.body;

    assert.equal(salaries.length, 2, 'both lines are returned');
    assert.equal(
      salaries.reduce((acc, l) => acc + l.to_ssn_cents, 0), s.salary_cents,
      'the lines add up to the monthly figure, to the cent'
    );
    assert.equal(
      salaries.reduce((acc, l) => acc + l.withheld_cents, 0), s.withheld_cents,
      'and so do the withheld amounts'
    );
    for (const line of salaries) {
      assert.equal(line.to_ssn_cents, line.credited_cents - line.tax_hold_cents);
      assert.equal(line.withheld_cents, line.invoice_cents - line.credited_cents);
    }
  });
});
