-- ===========================================================================
-- 009: a job pays a salary, and carries its own tax rate.
-- ===========================================================================
--
-- Two changes to how an SSN's month is built.
--
-- 1. The money on a job is a SALARY. jobs.amount_cents becomes
--    jobs.salary_cents, and an SSN's month is the sum of the salaries its
--    jobs paid.
--
-- 2. The tax rate moves from the SSN to the JOB. It used to be a standing
--    percentage on the SSN, applied once to the month's net; it is now asked
--    for on every job and applied to that job's own salary. The month's hold
--    is the sum of the per-job amounts.
--
-- The shape of the month, after this migration:
--
--     salary          sum of the salaries the SSN's jobs paid
--   - expenses        the costs charged to that SSN
--   - tax held        sum over its jobs of (salary x that job's rate)
--   = remaining
--   -> the SSN keeps its share, set when the SSN was created
--   -> the rest goes up to its sub-company
--
-- Note the tax is now taken from each job's salary, NOT from net after
-- expenses. The same percentage therefore holds back more than it did: 16% of
-- $8,000 of salaries is $1,280, where 16% of a $5,000 net was $800.
--
-- Existing rows keep their money. Each job inherits the rate its SSN used to
-- carry, so no job is left at 0% by accident.

-- --------------------------------------------- 1. the parent, without a rate --
--
-- org_units.tax_rate_bps has to go, and a CHECK constraint names it, so the
-- table is rebuilt. That forces the children to be rebuilt too: dropping
-- org_units performs an implicit DELETE which trips their foreign keys while
-- their rows still exist. Migration 008 documents why the pragma escapes
-- (defer_foreign_keys, legacy_alter_table) do not work from inside the
-- migration runner's transaction.
--
-- The old rate is read out of here into the jobs table below, so this table is
-- renamed aside rather than dropped until that is done.

ALTER TABLE org_units RENAME TO org_units_old;

CREATE TABLE org_units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('main','sub','ssn')),
  parent_id    INTEGER REFERENCES org_units(id),
  -- What an SSN KEEPS of what remains. 3000 = 30%. Set when the SSN is
  -- created; the remainder travels up the tree.
  share_bps    INTEGER CHECK (share_bps IS NULL OR (share_bps >= 0 AND share_bps <= 10000)),
  code         TEXT,
  description  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL,

  -- A main company has no parent; anything else must have one.
  CHECK ((kind = 'main' AND parent_id IS NULL) OR (kind <> 'main' AND parent_id IS NOT NULL)),
  -- Only an SSN carries a share. There is no tax rate here any more.
  CHECK (kind = 'ssn' OR share_bps IS NULL),
  CHECK (kind <> 'ssn' OR share_bps IS NOT NULL)
);

INSERT INTO org_units
  (id, name, kind, parent_id, share_bps, code, description, is_active,
   created_by, created_at, updated_by, updated_at)
SELECT
  id, name, kind, parent_id, share_bps, code, description, is_active,
  created_by, created_at, updated_by, updated_at
FROM org_units_old;

-- -------------------------------------- 2. jobs: salary, and their own rate --

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  ssn_id            INTEGER NOT NULL REFERENCES org_units(id),
  accounting_month  TEXT NOT NULL,
  job_date          TEXT NOT NULL,
  title             TEXT NOT NULL,
  client_name       TEXT,
  -- What this job pays the SSN.
  salary_cents      INTEGER NOT NULL CHECK (salary_cents >= 0),
  -- The tax rate for THIS job, applied to the salary above. 1000 = 10%.
  tax_rate_bps      INTEGER NOT NULL DEFAULT 0
                      CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','void')),
  notes             TEXT,
  attachment_id     INTEGER REFERENCES attachments(id),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL
);

-- Each job inherits the rate its SSN used to carry, so existing months keep a
-- sensible hold instead of silently dropping to zero.
INSERT INTO jobs_new
  (id, reference, ssn_id, accounting_month, job_date, title, client_name,
   salary_cents, tax_rate_bps, status, notes, attachment_id, is_demo,
   created_by, created_at, updated_by, updated_at)
SELECT
   j.id, j.reference, j.ssn_id, j.accounting_month, j.job_date, j.title, j.client_name,
   j.amount_cents,
   COALESCE((SELECT o.tax_rate_bps FROM org_units_old o WHERE o.id = j.ssn_id), 0),
   j.status, j.notes, j.attachment_id, j.is_demo,
   j.created_by, j.created_at, j.updated_by, j.updated_at
FROM jobs j;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_ssn_month ON jobs(ssn_id, accounting_month, status);
CREATE INDEX idx_jobs_month ON jobs(accounting_month, status);
CREATE INDEX idx_jobs_date ON jobs(job_date, status);

-- ----------------------------------------- 3. expenses, repointed unchanged --

CREATE TABLE expenses_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  ssn_id            INTEGER NOT NULL REFERENCES org_units(id),
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

INSERT INTO expenses_new
  (id, reference, ssn_id, accounting_month, expense_date, amount_cents, category_id,
   description, vendor, payment_method, payment_reference, status, attachment_id,
   is_demo, created_by, created_at, updated_by, updated_at)
SELECT
   id, reference, ssn_id, accounting_month, expense_date, amount_cents, category_id,
   description, vendor, payment_method, payment_reference, status, attachment_id,
   is_demo, created_by, created_at, updated_by, updated_at
FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expenses_ssn_month ON expenses(ssn_id, accounting_month, status);
CREATE INDEX idx_expenses_month ON expenses(accounting_month, status);
CREATE INDEX idx_expenses_date ON expenses(expense_date, status);
CREATE INDEX idx_expenses_category ON expenses(category_id);

-- ----------------------------------- 4. tax overrides, repointed unchanged --
--
-- Kept. The per-job rates compute the month's hold; this still records the
-- case where the real tax figure for a month differs from that sum, with a
-- reason and an author.

CREATE TABLE tax_overrides_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ssn_id           INTEGER NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  accounting_month TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  reason           TEXT NOT NULL,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL
);

INSERT INTO tax_overrides_new
  (id, ssn_id, accounting_month, amount_cents, reason,
   created_by, created_at, updated_by, updated_at)
SELECT
   id, ssn_id, accounting_month, amount_cents, reason,
   created_by, created_at, updated_by, updated_at
FROM tax_overrides;

DROP TABLE tax_overrides;
ALTER TABLE tax_overrides_new RENAME TO tax_overrides;

CREATE UNIQUE INDEX idx_tax_override_ssn_month ON tax_overrides(ssn_id, accounting_month);

-- ------------------------------------- 5. the old parent, now unreferenced --

DROP TABLE org_units_old;

CREATE UNIQUE INDEX idx_org_units_name ON org_units(parent_id, lower(name));
CREATE INDEX idx_org_units_parent ON org_units(parent_id, kind);
CREATE INDEX idx_org_units_kind ON org_units(kind, is_active);
