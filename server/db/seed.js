import { pathToFileURL } from 'node:url';
import { query, queryOne, execute, transaction, closeDb } from './connection.js';
import { migrate } from './migrate.js';
import { nowIso, monthKey, addMonths, currentMonth, toMonth } from '../lib/dates.js';
import { hashPassword, randomToken } from '../auth/passwords.js';
import { setSetting, DEFAULT_SETTINGS } from '../services/settings.js';
import { ssnMonth, mainMonth, mainUnit } from '../services/rollup.js';
import { nextReference } from '../lib/reference.js';

const EXPENSE_CATEGORIES = [
  'Software and subscriptions',
  'Operating expenses',
  'Contractor or service costs',
  'Payment processing fees',
  'SSN costs',
  'Other business expenses',
];

const one = (sql, params = {}) => queryOne(sql, params);

/**
 * Baseline data every installation needs: default settings, expense
 * categories and an owner account. Idempotent, so it is safe to run on every
 * boot and against an existing database.
 *
 * It deliberately does NOT invent a company structure. What the companies and
 * SSNs are called, and what each SSN keeps, is the first real
 * decision an owner makes -- guessing it would mean every install starts by
 * deleting someone else's org chart.
 */
export async function ensureBaseline() {
  const now = nowIso();
  const result = { created: [], ownerEmail: null, ownerPassword: null };

  await transaction(async () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(await one('SELECT key FROM settings WHERE key = $key', { key }))) {
        await execute('INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $now)',
          { key, value, now });
      }
    }

    for (const name of EXPENSE_CATEGORIES) {
      if (!(await one('SELECT id FROM expense_categories WHERE lower(name) = lower($name)', { name }))) {
        await execute(
          `INSERT INTO expense_categories (name, is_active, is_system, created_at, updated_at)
           VALUES ($name, 1, 1, $now, $now)`, { name, now }
        );
        result.created.push(`category:${name}`);
      }
    }

    if (!(await one("SELECT id FROM users WHERE role = 'owner'"))) {
      const email = String(process.env.OWNER_EMAIL ?? 'owner@example.com').toLowerCase();
      const password = process.env.OWNER_PASSWORD ?? `Vault-${randomToken(9)}`;
      await execute(
        `INSERT INTO users (email, name, password_hash, role, is_active, must_change_pw, created_at, updated_at)
         VALUES ($email, $name, $hash, 'owner', 1, $must, $now, $now)`,
        {
          email,
          name: process.env.OWNER_NAME ?? 'Owner',
          hash: hashPassword(password),
          must: process.env.OWNER_PASSWORD ? 0 : 1,
          now,
        }
      );
      result.created.push(`user:${email}`);
      result.ownerEmail = email;
      result.ownerPassword = password;
    }
  });

  return result;
}

/* ------------------------------------------------------------- structure -- */

const money = (dollars) => Math.round(dollars * 100);



/**
 * The company structure: MBS, its two sub-companies, their SSNs.
 *
 * This is NOT demo data and `clearDemo()` leaves it alone. An org chart is the
 * skeleton the books hang on: clearing the sample jobs should leave a working,
 * empty set of SSNs rather than an empty application.
 *
 * Idempotent on names, so running it twice adds nothing.
 */
export async function ensureStructure() {
  const now = nowIso();
  const created = [];

  const unit = async (name, kind, parentId, { share = null, code = null, description = null } = {}) => {
    const existing = await one(
      `SELECT * FROM org_units WHERE lower(name) = lower($name)
         AND ((parent_id IS NULL AND $parent::bigint IS NULL) OR parent_id = $parent)`,
      { name, parent: parentId }
    );
    if (existing) return existing;
    const result = await execute(
      `INSERT INTO org_units
         (name, kind, parent_id, share_bps, code, description, is_active,
          created_at, updated_at)
       VALUES ($name, $kind, $parent, $share, $code, $description, 1, $now, $now)
       RETURNING id`,
      { name, kind, parent: parentId, share, code, description, now }
    );
    created.push(`${kind}:${name}`);
    return one('SELECT * FROM org_units WHERE id = $id', { id: Number(result.lastInsertRowid) });
  };

  return transaction(async () => {
    const mbs = await unit('MBS', 'main', null, {
      code: 'MBS', description: 'Main company. Receives everything the sub-companies collect.',
    });
    const mbs1 = await unit('MBS1', 'sub', mbs.id, {
      code: 'MBS1', description: 'Sub-company. Collects from its SSNs and passes it all to MBS.',
    });
    const mbs2 = await unit('MBS2', 'sub', mbs.id, {
      code: 'MBS2', description: 'Sub-company. Collects from its SSNs and passes it all to MBS.',
    });

    // share_bps is what the SSN KEEPS; the rest goes up the tree. There is no
    // tax rate here -- each job carries its own.
    const alpha = await unit('Alpha', 'ssn', mbs1.id, { share: 3000, code: 'ALPHA' });
    const beta = await unit('Beta', 'ssn', mbs1.id, { share: 4000, code: 'BETA' });
    const gamma = await unit('Gamma', 'ssn', mbs2.id, { share: 3500, code: 'GAMMA' });

    return { created, mbs, mbs1, mbs2, alpha, beta, gamma };
  });
}

/* ------------------------------------------------------------------ demo -- */

/**
 * Sample records, so a fresh install shows the flow working end to end.
 *
 * Each SSN gets standing JOBS, and each job is paid a SALARY every month. The
 * first line of Alpha's current month is the worked example from the
 * specification, spelled out by hand because the README and the tests quote
 * its figures:
 *
 *   invoice 1,000.00, credited 800.00 -- so 200.00 was withheld by the hiring
 *   company under W2 -- and the job's 10% hold takes 80.00 of the 800, leaving
 *   720.00 for Alpha.
 *
 * Across all three of Alpha's jobs the month comes to:
 *
 *   invoiced          10,000.00
 *   credited           9,000.00     1,000.00 withheld by the companies
 *   - tax hold           900.00     each job's own % of its own credited amount
 *   = to Alpha         8,100.00
 *   - expenses         3,000.00
 *   = remaining        5,100.00
 *       Alpha keeps 30%  1,530.00
 *       up to MBS1 70%   3,570.00
 *
 * Earlier months are generated against the same jobs, so the trend chart and
 * the month picker have something to show. Every record is flagged
 * is_demo = 1.
 */
export async function seedDemo({ force = false } = {}) {
  const existing = await one('SELECT id FROM jobs WHERE is_demo = 1 LIMIT 1');
  if (existing && !force) {
    return { skipped: true, message: 'Sample data is already present. Re-run with --force to replace it.' };
  }
  if (existing && force) await clearDemo();

  const structure = await ensureStructure();
  const now = nowIso();
  const thisMonth = currentMonth();

  const category = async (name) => (await one(
    'SELECT id FROM expense_categories WHERE lower(name) = lower($name)', { name })).id;
  const operating = await category('Operating expenses');
  const software = await category('Software and subscriptions');
  const contractor = await category('Contractor or service costs');

  /** A standing engagement. Holds the terms; holds no money. */
  const addJob = async (ssn, { title, client, taxCategory, holdBps, joined }) => {
    const result = await execute(
      `INSERT INTO jobs
         (reference, ssn_id, title, client_name, tax_category, tax_hold_bps, joining_date,
          is_active, is_demo, created_at, updated_at)
       VALUES ($reference, $ssn, $title, $client, $category, $hold, $joined,
               1, 1, $now, $now)
       RETURNING id`,
      {
        reference: await nextReference('jobs', 'JOB', toMonth(joined)),
        ssn: ssn.id,
        title,
        client,
        category: taxCategory,
        hold: holdBps,
        joined,
        now,
      }
    );
    return Number(result.lastInsertRowid);
  };

  /**
   * One month's money on a job.
   *
   * `credited` defaults to the invoice, which is the ordinary 1099 case: the
   * full amount arrives and nothing is withheld.
   */
  const addSalary = async (jobId, month, { day, invoice, credited = invoice }) => {
    /*
     * A pay period running from the 21st of the previous month to the 20th of
     * this one: optional in the model, and set here because a period that
     * straddles a month boundary is exactly the case worth showing.
     */
    const periodFrom = `${monthKey(addMonths(month, -1))}-21`;
    const periodTo = `${monthKey(month)}-20`;
    await execute(
      `INSERT INTO salaries
         (reference, job_id, accounting_month, invoice_amount_cents, credited_amount_cents,
          credit_date, pay_period_from, pay_period_to, status, is_demo, created_at, updated_at)
       VALUES ($reference, $job, $month, $invoice, $credited, $date,
               $period_from, $period_to, 'active', 1, $now, $now)`,
      {
        reference: await nextReference('salaries', 'SAL', month),
        job: jobId,
        month,
        invoice: money(invoice),
        credited: money(credited),
        date: `${monthKey(month)}-${String(day).padStart(2, '0')}`,
        period_from: periodFrom,
        period_to: periodTo,
        now,
      }
    );
  };

  const addExpense = async (ssn, month, { day, description, amount, categoryId, vendor }) => {
    await execute(
      `INSERT INTO expenses
         (reference, ssn_id, accounting_month, expense_date, amount_cents, category_id,
          description, vendor, status, is_demo, created_at, updated_at)
       VALUES ($reference, $ssn, $month, $date, $amount, $category, $description, $vendor,
               'approved', 1, $now, $now)`,
      {
        reference: await nextReference('expenses', 'EX', month),
        ssn: ssn.id,
        month,
        date: `${monthKey(month)}-${String(day).padStart(2, '0')}`,
        amount: money(amount),
        category: categoryId,
        description,
        vendor,
        now,
      }
    );
  };

  return transaction(async () => {
    const { alpha, beta, gamma } = structure;
    // The engagements all started six months ago, so every generated month
    // falls after their joining date.
    const started = `${monthKey(addMonths(thisMonth, -6))}-01`;

    /* ----------------------------------------------- the standing jobs -- */
    const jobs = {
      // Alpha. The first is the worked example: 1,000 invoiced, 800 credited.
      alphaW2: await addJob(alpha, {
        title: 'Website rebuild', client: 'Harbour Logistics',
        taxCategory: 'w2', holdBps: 1000, joined: started,
      }),
      alpha1099: await addJob(alpha, {
        title: 'Mobile app phase 1', client: 'Northwind Retail',
        taxCategory: '1099', holdBps: 1000, joined: started,
      }),
      alphaW2b: await addJob(alpha, {
        title: 'Analytics dashboard', client: 'Cedar Health',
        taxCategory: 'w2', holdBps: 1000, joined: started,
      }),

      beta1099: await addJob(beta, {
        title: 'Brand refresh', client: 'Lumen Foods',
        taxCategory: '1099', holdBps: 1200, joined: started,
      }),
      betaW2: await addJob(beta, {
        title: 'Campaign retainer', client: 'Vertex Media',
        taxCategory: 'w2', holdBps: 1200, joined: started,
      }),

      gammaW2: await addJob(gamma, {
        title: 'Data migration', client: 'Fairline Group',
        taxCategory: 'w2', holdBps: 1500, joined: started,
      }),
    };

    /* --------------------------------- the worked example, this month -- */
    // 1,000 invoiced, 800 credited: 200 withheld, 80 held at 10%, 720 to Alpha.
    await addSalary(jobs.alphaW2, thisMonth, { day: 4, invoice: 1000, credited: 800 });
    await addSalary(jobs.alpha1099, thisMonth, { day: 11, invoice: 5000 });
    await addSalary(jobs.alphaW2b, thisMonth, { day: 19, invoice: 4000, credited: 3200 });

    await addExpense(alpha, thisMonth, {
      day: 6, description: 'Contract designer', amount: 1800, categoryId: contractor, vendor: 'Studio Kite',
    });
    await addExpense(alpha, thisMonth, {
      day: 12, description: 'Team tooling and licences', amount: 700, categoryId: software, vendor: 'Atlassian',
    });
    await addExpense(alpha, thisMonth, {
      day: 22, description: 'Office and utilities share', amount: 500, categoryId: operating, vendor: 'Regus',
    });

    /* ------------------------------------- the other SSNs, for shape -- */
    await addSalary(jobs.beta1099, thisMonth, { day: 7, invoice: 4000 });
    await addSalary(jobs.betaW2, thisMonth, { day: 21, invoice: 3000, credited: 2400 });
    await addExpense(beta, thisMonth, {
      day: 9, description: 'Freelance copywriting', amount: 1200, categoryId: contractor, vendor: 'J. Okafor',
    });

    await addSalary(jobs.gammaW2, thisMonth, { day: 5, invoice: 7000, credited: 6000 });
    await addExpense(gamma, thisMonth, {
      day: 14, description: 'Cloud hosting', amount: 900, categoryId: software, vendor: 'AWS',
    });

    /* -------------------------------------------- five earlier months -- */
    /*
     * W2 rows are credited at 80% of the invoice so the withheld column has
     * something in it every month; 1099 rows arrive in full.
     */
    const pattern = [
      { alpha: [1100, 4800, 3900], beta: [3600, 2800], gamma: [6600], alphaCost: 2200, betaCost: 900, gammaCost: 700 },
      { alpha: [1000, 5200, 4100], beta: [4100, 2500], gamma: [6100], alphaCost: 2600, betaCost: 1100, gammaCost: 820 },
      { alpha: [1200, 4600, 4400], beta: [2900, 3100], gamma: [7200], alphaCost: 1900, betaCost: 760, gammaCost: 1050 },
      { alpha: [900, 5000, 3600], beta: [3300, 2600], gamma: [6400], alphaCost: 2400, betaCost: 840, gammaCost: 910 },
      { alpha: [1050, 5400, 4200], beta: [3800, 2900], gamma: [6900], alphaCost: 2750, betaCost: 1250, gammaCost: 980 },
    ];
    const w2 = (invoice) => ({ invoice, credited: Math.round(invoice * 0.8) });

    for (const [index, row] of pattern.entries()) {
      const month = addMonths(thisMonth, -(pattern.length - index));

      await addSalary(jobs.alphaW2, month, { day: 5, ...w2(row.alpha[0]) });
      await addSalary(jobs.alpha1099, month, { day: 13, invoice: row.alpha[1] });
      await addSalary(jobs.alphaW2b, month, { day: 21, ...w2(row.alpha[2]) });
      await addExpense(alpha, month, {
        day: 24, description: 'Monthly running costs', amount: row.alphaCost,
        categoryId: operating, vendor: 'Various',
      });

      await addSalary(jobs.beta1099, month, { day: 6, invoice: row.beta[0] });
      await addSalary(jobs.betaW2, month, { day: 15, ...w2(row.beta[1]) });
      await addExpense(beta, month, {
        day: 25, description: 'Monthly running costs', amount: row.betaCost,
        categoryId: operating, vendor: 'Various',
      });

      await addSalary(jobs.gammaW2, month, { day: 8, ...w2(row.gamma[0]) });
      await addExpense(gamma, month, {
        day: 26, description: 'Monthly running costs', amount: row.gammaCost,
        categoryId: operating, vendor: 'Various',
      });
    }

    await setSetting('demo_mode', 'true', null);

    const alphaStatement = await ssnMonth(alpha, thisMonth);
    const roll = await mainMonth(thisMonth);
    return {
      skipped: false,
      structure_created: structure.created,
      month: thisMonth,
      alpha: alphaStatement,
      received_by_mbs_cents: roll.total_received_cents,
    };
  });
}


/**
 * Remove every sample record, leaving the company structure and anything a
 * user entered themselves untouched.
 */
export function clearDemo() {
  return transaction(async () => {
    const salaries = await query('SELECT id FROM salaries WHERE is_demo = 1');
    const jobs = await query('SELECT id FROM jobs WHERE is_demo = 1');
    const expenses = await query('SELECT id FROM expenses WHERE is_demo = 1');
    // Salaries first: they point at the jobs.
    await execute('DELETE FROM salaries WHERE is_demo = 1');
    await execute('DELETE FROM jobs WHERE is_demo = 1');
    await execute('DELETE FROM expenses WHERE is_demo = 1');
    await setSetting('demo_mode', 'false', null);
    return { salaries: salaries.length, jobs: jobs.length, expenses: expenses.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate({ silent: true });
  const baseline = await ensureBaseline();
  if (baseline.ownerPassword) {
    console.log(`Owner account created: ${baseline.ownerEmail} / ${baseline.ownerPassword}`);
  }

  if (process.argv.includes('--clear')) {
    console.log('Clearing sample data...', await clearDemo());
    console.log(`Company structure kept: ${(await mainUnit())?.name ?? 'none'}`);
  } else if (process.argv.includes('--structure-only')) {
    console.log('Company structure:', (await ensureStructure()).created);
  } else {
    const result = await seedDemo({ force: process.argv.includes('--force') });
    if (result.skipped) console.log(result.message);
    else {
      const d = (cents) => `$${(cents / 100).toFixed(2)}`;
      console.log(`Sample data seeded. Alpha, ${result.month}:`);
      console.log(`  invoiced       ${d(result.alpha.invoice_cents)}`);
      console.log(`  credited       ${d(result.alpha.credited_cents)}`
        + `   (${d(result.alpha.withheld_cents)} withheld by the companies)`);
      console.log(`  - tax hold     ${d(result.alpha.tax_hold_cents)}`);
      console.log(`  = to Alpha     ${d(result.alpha.salary_cents)}`);
      console.log(`  - expenses     ${d(result.alpha.expense_cents)}`);
      console.log(`  = remaining    ${d(result.alpha.distributable_cents)}`);
      console.log(`  Alpha keeps 30% ${d(result.alpha.keep_cents)}`);
      console.log(`  up to MBS1 70%  ${d(result.alpha.upstream_cents)}`);
      console.log(`  MBS received    ${d(result.received_by_mbs_cents)} (all SSNs)`);
    }
  }
  await closeDb();
}
