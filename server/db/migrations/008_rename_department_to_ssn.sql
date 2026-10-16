-- ===========================================================================
-- 008: a department is called an SSN.
-- ===========================================================================
--
-- Terminology only. Nothing about the flow changes: an SSN still lands jobs,
-- carries its own expenses, holds tax from its net, keeps its share and sends
-- the remainder up to its sub-company.
--
--   MBS                   main company
--   |- MBS1               sub-company
--   |   |- Alpha          SSN            keeps 30%
--   |   |- Beta           SSN            keeps 40%
--   |- MBS2               sub-company
--       |- Gamma          SSN            keeps 35%
--
-- Every table is rebuilt rather than altered in place, because the rename
-- reaches a CHECK constraint (kind IN ('main','sub','dept')) and SQLite cannot
-- alter one. No row is deleted and no id changes, so every job, expense and
-- tax override keeps pointing at the same unit it always did.
--
-- Why a rebuild of the CHILDREN and not just the parent
-- -----------------------------------------------------
-- Dropping org_units performs an implicit DELETE, which trips the foreign keys
-- in jobs, expenses and tax_overrides while their rows still exist. Two
-- obvious escapes do not work from inside the migration runner's transaction:
--
--   * PRAGMA defer_foreign_keys only postpones the check. The implicit DELETE
--     still increments a pending-violation counter that the later rename never
--     decrements, so the transaction fails at COMMIT.
--   * PRAGMA legacy_alter_table is ignored for this purpose while
--     PRAGMA foreign_keys is ON: a table rename then rewrites the REFERENCES
--     clauses in other tables regardless, so the children follow the old table
--     aside instead of staying pointed at the name.
--
-- So the parent is moved aside, a new one is built under the canonical name,
-- and then each child is rebuilt so its own foreign key names the new parent.
-- Once no child references the old table, it drops cleanly.

-- ------------------------------------------------- 1. the parent, rebuilt --

ALTER TABLE org_units RENAME TO org_units_old;

CREATE TABLE org_units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('main','sub','ssn')),
  parent_id    INTEGER REFERENCES org_units(id),
  -- What an SSN KEEPS of its own distributable amount. 3000 = 30%.
  -- The remainder is what travels up the tree.
  share_bps    INTEGER CHECK (share_bps IS NULL OR (share_bps >= 0 AND share_bps <= 10000)),
  -- Default tax-hold rate for an SSN. 1600 = 16%.
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
  -- Only an SSN carries a share and a tax rate.
  CHECK (kind = 'ssn' OR (share_bps IS NULL AND tax_rate_bps IS NULL)),
  CHECK (kind <> 'ssn' OR (share_bps IS NOT NULL AND tax_rate_bps IS NOT NULL))
);

INSERT INTO org_units
  (id, name, kind, parent_id, share_bps, tax_rate_bps, code, description, is_active,
   created_by, created_at, updated_by, updated_at)
SELECT
  id, name,
  CASE kind WHEN 'dept' THEN 'ssn' ELSE kind END,
  parent_id, share_bps, tax_rate_bps, code, description, is_active,
  created_by, created_at, updated_by, updated_at
FROM org_units_old;

-- ------------------------------------------------------- 2. jobs, rebuilt --

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  ssn_id            INTEGER NOT NULL REFERENCES org_units(id),
  accounting_month  TEXT NOT NULL,
  job_date          TEXT NOT NULL,
  title             TEXT NOT NULL,
  client_name       TEXT,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','void')),
  notes             TEXT,
  attachment_id     INTEGER REFERENCES attachments(id),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL
);

INSERT INTO jobs_new
  (id, reference, ssn_id, accounting_month, job_date, title, client_name, amount_cents,
   status, notes, attachment_id, is_demo, created_by, created_at, updated_by, updated_at)
SELECT
   id, reference, dept_id, accounting_month, job_date, title, client_name, amount_cents,
   status, notes, attachment_id, is_demo, created_by, created_at, updated_by, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_ssn_month ON jobs(ssn_id, accounting_month, status);
CREATE INDEX idx_jobs_month ON jobs(accounting_month, status);
CREATE INDEX idx_jobs_date ON jobs(job_date, status);

-- --------------------------------------------------- 3. expenses, rebuilt --

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
   id, reference, dept_id, accounting_month, expense_date, amount_cents, category_id,
   description, vendor, payment_method, payment_reference, status, attachment_id,
   is_demo, created_by, created_at, updated_by, updated_at
FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expenses_ssn_month ON expenses(ssn_id, accounting_month, status);
CREATE INDEX idx_expenses_month ON expenses(accounting_month, status);
CREATE INDEX idx_expenses_date ON expenses(expense_date, status);
CREATE INDEX idx_expenses_category ON expenses(category_id);

-- ---------------------------------------------- 4. tax overrides, rebuilt --

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
   id, dept_id, accounting_month, amount_cents, reason,
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

-- A category named for the old word, renamed only if nobody has taken the new
-- name already.
UPDATE expense_categories
   SET name = 'SSN costs'
 WHERE lower(name) = 'department costs'
   AND NOT EXISTS (SELECT 1 FROM expense_categories WHERE lower(name) = 'ssn costs');
