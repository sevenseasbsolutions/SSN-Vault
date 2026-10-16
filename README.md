# Vault — Company, SSN & Share Management

A financial management application for a company that earns through its SSNs.
Each SSN works jobs; each job pays a salary every month; tax is held per job;
expenses come off the SSN's total, and the share each SSN keeps is settled
before the rest travels up to the company above it.

---

## The model

Three levels. Only an SSN earns, and only an SSN keeps a share.

```
MBS                     main company      receives everything
├── MBS1                sub-company       collects from its SSNs
│   ├── Alpha           SSN               keeps 30%
│   └── Beta            SSN               keeps 40%
└── MBS2                sub-company
    └── Gamma           SSN               keeps 35%
```

### A job, and its salaries

A **job** is a standing engagement: an SSN, a client, a tax category (**W2** or
**1099**), a **tax-hold %** and a joining date. It holds no money. One job pays
many salaries — one per accounting month.

A **salary** records two amounts, and the rest is derived:

| | |
|---|---|
| **Invoice amount** | what was billed |
| **Amount credited** | what actually arrived |
| = Deducted | the difference, kept by the hiring company under W2 |
| − Tax Hold | the **job's** hold %, applied to the **credited** amount |
| **= To the SSN** | |

The deducted amount is recorded and reported but **never taken off the SSN
again** — it never reached the SSN, so subtracting it twice would double-count
it.

A salary may also carry an optional **pay period** (from / to). It is
descriptive and changes no figure: a period routinely runs from one month into
the next, and the accounting month is what decides which statement the money
lands in. The salary register can be filtered by periods that *overlap* a
range, so a period running 21 Sep – 5 Oct is found by an October search.

### Then the SSN's month

| step | where it comes from |
|---|---|
| **To the SSN** | summed across all its salaries that month |
| − Expenses | the costs charged to that SSN |
| **= Remaining** | |
| → **SSN keeps** | its share, set when the SSN was created |
| → **Passed up** | the remainder, to its sub-company |

The tax hold comes off **before** the SSN's expenses: tax is owed on what was
earned, not on what is left after the SSN's own costs.

A sub-company **keeps nothing**. It collects what its SSNs send up and passes
all of it to the main company. The main company's total is therefore the sum of
every SSN's upstream amount.

### Worked example

One salary, on a W2 job holding 10%:

```
  invoiced                  $1,000.00
  credited                    $800.00
  = deducted                  $200.00   kept by the company under W2
  - tax hold                   $80.00   10% of the 800 credited
  = to the SSN                $720.00
```

Alpha's whole month, across its three jobs:

```
  invoiced                 $10,000.00
  credited                  $9,000.00   $1,000.00 deducted by the companies
  - tax hold                  $900.00   each job at its own rate
  = to Alpha                $8,100.00
  - expenses                $3,000.00
  = remaining               $5,100.00
      Alpha keeps 30%       $1,530.00
      up to MBS1  70%       $3,570.00
```

`$1,530.00 + $3,570.00 = $5,100.00` — what is kept and what goes up always
reconcile to the cent. Both examples are the sample data (`npm run seed`) and
are asserted in `tests/company-rollup.test.js`.

---

## Quick start

```bash
npm install
npm start
```

The first run creates `data/vault.db`, applies the migrations, creates an owner
account and prints a one-time password:

```
==================================================================
  First run: an owner account has been created.
  Email:    owner@example.com
  Password: Vault-xxxxxxxxxxxx
  You will be asked to change this password after signing in.
==================================================================
```

Open <http://127.0.0.1:4000> and sign in. You will be prompted to set a new
password immediately.

To choose the owner credentials yourself:

```bash
OWNER_EMAIL=you@example.com OWNER_PASSWORD='a-long-passphrase' npm start
```

A fresh install has **no company structure**: what your companies and SSNs are
called, and what each SSN keeps, is yours to set. Go to **Structure** and create
the main company, then a sub-company, then the SSNs. Then **Jobs** to set up an
engagement, and **Salaries** to record what it pays each month.

### Sample data

```bash
npm run seed              # the example above, plus five earlier months
npm run seed --force      # replace existing sample data
npm run seed:clear        # remove it, KEEPING the company structure
```

Sample jobs, salaries and expenses are flagged `is_demo = 1` and a banner marks
them in the UI. `seed:clear` removes those records only: the company structure
and anything you entered yourself stay.

```bash
node server/db/seed.js --structure-only   # the MBS tree, no sample records
```

### Tests

```bash
npm test
```

39 tests across 6 files, each with its own throwaway database and HTTP server:

| file | what it guards |
|---|---|
| `company-rollup.test.js` | the salary chain, the waterfall and the roll-up, including the worked example |
| `permissions-security.test.js` | permissions, scope isolation, ID probing, the audit trail |
| `primitives.test.js` | decimal-safe money and accounting-month arithmetic |

---

## Commands

| command | what it does |
|---|---|
| `npm start` | run the server |
| `npm run dev` | run with `--watch` |
| `npm run migrate` | apply pending migrations |
| `npm run seed` | insert sample data |
| `npm run seed:clear` | remove sample data, keep the structure |
| `npm run reset` | **delete the database file** (asks for confirmation) |
| `npm test` | run the test suite |

---

## How the money is computed

`server/services/rollup.js` is the only place a financial formula lives. The
dashboard, the statements, the reports and the exports all call it, so they
cannot disagree with each other.

Nothing computed is stored. Jobs, salaries, expenses and tax overrides are the
only inputs; every total is derived on read, so correcting a salary can never
leave a stale figure behind.

### Documented assumptions

1. A salary and an expense belong to the **accounting month a user assigned**
   to them. A job's joining date and a salary's credit date are descriptive and
   never move money into a different month.
2. Only salaries with status `active` count. `draft` is not yet real; `void`
   has been reversed. Marking a job inactive stops new salaries but does not
   retrospectively remove those already recorded against it.
3. Only expenses with status `approved` are deducted.
4. Tax is held **per salary**, from the **credited** amount, at the rate its
   job carries — so two salaries in one month can be held at different rates.
   Each is truncated on its own before being summed, so the monthly figure is
   exactly the sum of the lines the statement lists.
5. The hold is clamped to the credited total, so it can never exceed the money
   it is held out of; an override is clamped the same way. And more cannot be
   credited than was invoiced, or the deducted amount would go negative.
6. `keep + upstream == distributable`, to the cent, always. The kept amount is
   the truncated basis-point share and the upstream amount is the exact
   residual, so rounding can neither create nor lose a cent.
7. **A loss stays where it was made.** If the distributable amount is negative
   the SSN carries all of it and nothing flows upstream: an SSN
   having a bad month must not reach into its parent's pocket, and the parent
   must not be shown income that does not exist.
8. A sub-company keeps nothing, so what it passes on always equals what it
   collected.

### The tax hold

The rate lives on each job and applies to every salary recorded against it.
When the real tax bill for a month differs from what those salaries come to,
record an **override** on that month's statement rather than editing the
salaries — they stay as recorded, and the exception is kept with its reason and
its author. One override per SSN per month; recording it twice corrects the
figure rather than stacking two holds.

Editing a job's hold **restates every month it has already paid into**, because
the engine derives each hold from the job's current rate. The API says so on
its response and the UI raises it as a warning.

### Percentages

Stored as integer basis points (`3000` = 30%), never as floats. The API accepts
either a percentage in `share` / `tax_rate` or basis points in `share_bps` /
`tax_rate_bps`, and always stores basis points.

### Money

Stored and computed as integer cents. Binary floating point is never used for
arithmetic that reaches the database or a reconciliation.

### Reference numbers

`JOB-202610-0001`, `SAL-202610-0001`, `EX-202610-0001`: one sequence per kind,
per month. The next
number comes from the **highest already issued**, never from a row count — a
count-based sequence silently breaks the first time a record is deleted, and
then fails every later insert for that month. `server/lib/reference.js` exists
so that mistake cannot be made once per table.

---

## Roles and access

| role | can |
|---|---|
| **owner** | everything, including users and settings |
| **editor** | record and edit jobs and expenses, view everything, export |
| **viewer** | read only |

Permissions are enforced on the server inside every request handler, never only
by hiding a button. Per-user allow/deny rows layer over the role defaults, and
an explicit **deny always wins**. `users.manage` and `settings.manage` can only
ever be held by an owner account.

### Scope

Access narrows on one axis: the company tree. A user scoped to a sub-company
reaches every SSN under it — **including SSNs added later**,
because the grant is expanded on read rather than copied at grant time. Leave
the scope empty for the whole company.

A scoped user's dashboard, registers, tax page, statements and exports all
narrow to what they can see, and a record outside their scope returns 404
rather than 403, so ids cannot be probed for existence.

### Security

- Session cookies are `HttpOnly`, `SameSite=Strict`, and hashed in the database.
- Double-submit CSRF token, required in a header, on every state-changing request.
- A strict CSP with no inline scripts and no remote origins.
- Passwords are hashed with `scrypt`; failed logins lock an account temporarily.
- Changing a user's role revokes that user's sessions immediately.
- Deleting is off until an owner turns it on in Settings, needs a reason, and is
  recorded in the audit history. An SSN with jobs or expenses behind it
  cannot be deleted at all — deactivate it, so its past months keep reconciling.

---

## Layout

```
server/
  services/rollup.js      THE calculation engine; every total comes from here
  routes/org.js           the company tree, shares, statements
  routes/jobs.js          engagements and their tax terms
  routes/salaries.js      the money: invoiced, credited, per month
  routes/expenses.js      costs, charged to one SSN
  routes/tax.js           the tax page and month overrides
  routes/dashboard.js     one month, the whole tree
  routes/reports.js       reports and exports
  lib/money.js            decimal-safe money and basis points
  lib/reference.js        per-month reference sequences
  lib/dates.js            accounting months; toMonth() is the only normaliser
  auth/                   sessions, permissions, scopes
  db/migrations/          forward-only SQL migrations
public/
  js/views/org.js         the structure, as a tree
  js/views/statement.js   an SSN's month, as a waterfall
  js/views/jobs.js        the job register
  js/views/expenses.js    the expense register
  js/views/dashboard.js   the roll-up
```

### Accounting months

The canonical form is `YYYY-MM-01`, which is what the database stores and what
month arithmetic expects. `toMonth()` is the only place a month is derived;
`monthKey()` trims to `YYYY-MM` for display only. Passing a `Date` to either
returns nothing useful — use `currentMonth()`.

---

## Reports and exports

| report | question |
|---|---|
| **Month** | what every SSN did in one month, and what reached the main company |
| **SSN** | one SSN across a range of months |
| **Audit history** | who changed what, when, and why |

Every report states the basis it is built on. CSV and Excel are rendered from
the same rows the screen shows, from one column definition, so the two formats
cannot drift apart. Text cells are neutralised against spreadsheet formula
injection.

---

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `4000` | listening port |
| `HOST` | `127.0.0.1` | bind address |
| `DATABASE_PATH` | `data/vault.db` | SQLite file, or `:memory:` |
| `OWNER_EMAIL` | `owner@example.com` | first-run owner account |
| `OWNER_PASSWORD` | generated | first-run password |
| `SESSION_TTL_HOURS` | `12` | session lifetime |
| `RATE_LIMIT_PER_MINUTE` | `600` | per-user API rate limit |
| `COOKIE_SECURE` | off | set with TLS in front |
| `TRUST_PROXY` | `0` | hops to trust for client IP |

---

## Deployment

Single Node process, SQLite in WAL mode, no external services. Put TLS in front
and set `COOKIE_SECURE=true` and `TRUST_PROXY=1`.

Back up `data/vault.db` with SQLite's own backup, not a file copy of a live
database:

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); \
  new DatabaseSync('data/vault.db',{readOnly:true}).exec(\"VACUUM INTO 'backup.db'\")"
```

---

## Not claimed

- Not multi-tenant. One company tree per database.
- No month locking. A past month can still be edited; the audit history records
  who did it, but nothing prevents it.
- Sub-companies cannot keep a share. The model is deliberate (assumption 8) and
  `splitDistributable` in `rollup.js` is the one place that would change.
- The tax category (W2 / 1099) is descriptive. It does not change the
  arithmetic: a 1099 job may still record a gap between invoiced and credited,
  and a W2 job may record none.
- Editing a job's tax hold restates its past months rather than versioning the
  rate by date.
- No double-entry ledger, no bank reconciliation, no payroll filing.
- The tree is fixed at three levels. `org_units` is self-referencing so a
  fourth would not need a schema change, but the shape rules in `routes/org.js`
  and the roll-up in `rollup.js` assume three.
