-- ===========================================================================
-- 007: redefine the system around a company hierarchy.
-- ===========================================================================
--
-- The old model was partner-centric: pools of partners, salary payouts, W2 and
-- a distribution run that split a pool's net income between partners and the
-- owner. That model is retired in full.
--
-- The new model is a three-level company tree. Only a department earns, and
-- only a department keeps a share:
--
--   MBS                     main company      receives everything
--   |- MBS1                 sub-company       collects from its departments
--   |   |- Alpha            department        lands jobs, keeps 30%
--   |   |- Beta             department        lands jobs, keeps 40%
--   |- MBS2                 sub-company
--       |- ...
--
-- Per department, per accounting month:
--
--   revenue (jobs landed)
--   - expenses
--   = net
--   - tax hold              (the department's rate, overridable for a month)
--   = distributable
--   -> the department keeps share_bps of it
--   -> the remainder goes up to its sub-company
--
-- A sub-company keeps nothing: it passes everything it collects to the main
-- company. That is a deliberate modelling decision, not an oversight -- see
-- services/rollup.js.
--
-- Nothing below is stored as a computed total. Jobs, expenses and tax
-- overrides are the only inputs; every figure above is derived on read, so a
-- corrected job can never leave a stale total behind.

-- --------------------------------------------------------- retire the old --
-- Children before parents, so the implicit DELETE that DROP performs under
-- PRAGMA foreign_keys = ON never trips a constraint.

DROP TABLE IF EXISTS distribution_payments;
DROP TABLE IF EXISTS partner_distributions;
DROP TABLE IF EXISTS distribution_runs;
DROP TABLE IF EXISTS deficit_carryforwards;
DROP TABLE IF EXISTS tax_reserve_overrides;
DROP TABLE IF EXISTS tax_reserve_ledger;
DROP TABLE IF EXISTS tax_reserve_policies;
DROP TABLE IF EXISTS expense_allocations;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS payouts;
DROP TABLE IF EXISTS accounting_periods;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS partner_share_agreements;
DROP TABLE IF EXISTS partner_profiles;
DROP TABLE IF EXISTS partners;
DROP TABLE IF EXISTS distribution_pools;

-- ------------------------------------------------------------- org units --
--
-- One self-referencing table rather than three, so the tree can be walked with
-- a single recursive query and a new level never needs a schema change.
--
-- kind drives the rules, enforced here as far as SQL can and completed in
-- routes/org.js:
--   main  parent_id IS NULL, no share, no tax rate   (exactly one, enforced in code)
--   sub   parent_id is a main
--   dept  parent_id is a sub, share_bps and tax_rate_bps required

CREATE TABLE org_units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('main','sub','dept')),
  parent_id    INTEGER REFERENCES org_units(id),
  -- What a department KEEPS of its own distributable amount. 3000 = 30%.
  -- The remainder is what travels up the tree.
  share_bps    INTEGER CHECK (share_bps IS NULL OR (share_bps >= 0 AND share_bps <= 10000)),
  -- Default tax-hold rate for a department. 1600 = 16%.
  tax_rate_bps INTEGER CHECK (tax_rate_bps IS NULL OR (tax_rate_bps >= 0 AND tax_rate_bps <= 10000)),
  code         TEXT,
  description  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL,

  -- A main company has no parent; anything else must have one.
  CHECK ((kind = 'main' AND parent_id IS NULL) OR (kind <> 'main' AND parent_id IS NOT NULL)),
  -- Only a department carries a share and a tax rate.
  CHECK (kind = 'dept' OR (share_bps IS NULL AND tax_rate_bps IS NULL)),
  CHECK (kind <> 'dept' OR (share_bps IS NOT NULL AND tax_rate_bps IS NOT NULL))
);
CREATE UNIQUE INDEX idx_org_units_name ON org_units(parent_id, lower(name));
CREATE INDEX idx_org_units_parent ON org_units(parent_id, kind);
CREATE INDEX idx_org_units_kind ON org_units(kind, is_active);

-- ------------------------------------------------------------------ jobs --
--
-- A job is the only source of revenue. It belongs to exactly one department
-- and to the accounting month the user assigned it, which is what the monthly
-- statement is built from -- job_date never moves it.

CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  dept_id           INTEGER NOT NULL REFERENCES org_units(id),
  accounting_month  TEXT NOT NULL,
  job_date          TEXT NOT NULL,
  title             TEXT NOT NULL,
  client_name       TEXT,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- 'draft' is not yet real revenue; 'void' has been reversed. Only 'active'
  -- counts, which mirrors how the old register treated a payout.
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','void')),
  notes             TEXT,
  attachment_id     INTEGER REFERENCES attachments(id),
  -- Sample records are flagged so they can be cleared without touching the
  -- company structure or anything a user entered themselves.
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_jobs_dept_month ON jobs(dept_id, accounting_month, status);
CREATE INDEX idx_jobs_month ON jobs(accounting_month, status);
CREATE INDEX idx_jobs_date ON jobs(job_date, status);

-- -------------------------------------------------------------- expenses --
--
-- An expense is charged to one department and deducted from that department's
-- revenue in its accounting month. The old allocation table is gone: with the
-- department as the unit of account there is nothing left to split a cost
-- across, so a cost cannot be double-counted by construction.

CREATE TABLE expenses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  dept_id           INTEGER NOT NULL REFERENCES org_units(id),
  accounting_month  TEXT NOT NULL,
  expense_date      TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  category_id       INTEGER NOT NULL REFERENCES expense_categories(id),
  description       TEXT,
  vendor            TEXT,
  payment_method    TEXT,
  payment_reference TEXT,
  status            TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','void')),
  attachment_id     INTEGER REFERENCES attachments(id),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_expenses_dept_month ON expenses(dept_id, accounting_month, status);
CREATE INDEX idx_expenses_month ON expenses(accounting_month, status);
CREATE INDEX idx_expenses_date ON expenses(expense_date, status);
CREATE INDEX idx_expenses_category ON expenses(category_id);

-- --------------------------------------------------------- tax overrides --
--
-- The department's rate computes the hold. When the real tax figure for a
-- month differs, it is overridden here rather than by editing the rate, so
-- the rate stays the standing policy and the exception is recorded with a
-- reason and an author. One override per department per month.

CREATE TABLE tax_overrides (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dept_id          INTEGER NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  accounting_month TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  reason           TEXT NOT NULL,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_tax_override_dept_month ON tax_overrides(dept_id, accounting_month);

-- ------------------------------------------------------------- new scopes --
--
-- Row-level access used to be granted per partner, profile, company or pool,
-- none of which exist any more. The one axis that matters now is the org tree:
-- a user is scoped to a sub-company (which reaches its departments) or to
-- individual departments.
--
-- Safe to drop and recreate: nothing has a foreign key pointing AT this table,
-- it only points out to users.
--
-- users.role is deliberately left alone. Its CHECK still lists the retired
-- 'partner' role, but nothing creates one; the roles in use are owner, editor
-- and viewer. Rebuilding the users table to tighten a CHECK would mean
-- dropping a table that audit_log, attachments, jobs and expenses all
-- reference -- a real risk, for no behavioural gain.

DROP TABLE IF EXISTS user_scopes;

CREATE TABLE user_scopes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org_unit')),
  scope_id   INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_id)
);
