-- ===========================================================================
-- 010: a job is an engagement; a salary is a payment on it.
-- ===========================================================================
--
-- A job used to be one month's money. It is now a standing engagement under
-- an SSN, and the money arrives as SALARIES -- one per month, many per job.
--
--   JOB (set up once)
--     SSN, title, client
--     tax category     'w2' or '1099'
--     tax hold %       applied to each salary's CREDITED amount
--     joining date     when the engagement started
--
--   SALARY (one per accounting month, many per job)
--     invoice amount   what was billed, e.g. 1,000.00
--     credited amount  what actually arrived, e.g. 800.00
--
-- The 200.00 difference is what the hiring company withheld under W2. It is
-- recorded and reported but NEVER deducted from the SSN again: it never
-- reached the SSN, so subtracting it a second time would double-count it.
--
-- Per salary:
--     credited                                  800.00
--   - the job's tax hold % of credited           80.00   (at 10%)
--   = to the SSN                                720.00
--
-- Per SSN, per accounting month:
--     the sum of that figure across its salaries
--   - the SSN's expenses
--   = remaining            -> the SSN keeps its share, the rest goes up
--
-- Existing data is converted rather than discarded. Each old job becomes an
-- engagement plus one salary for the month it carried, with the invoice and
-- credited amounts both set to the old salary figure -- there was no withheld
-- amount to recover, so those rows are marked '1099' and show no gap.

-- ----------------------------------------------- 1. jobs become engagements --
--
-- Rebuilt rather than altered: the money columns go, the CHECK on status goes,
-- and new NOT NULL columns arrive.
--
-- The ORDER below matters. salaries.job_id points at jobs, so the salaries
-- table cannot exist while the old jobs table is being dropped -- the implicit
-- DELETE that DROP performs would trip that key. So the old money is parked in
-- a staging table first, jobs is swapped, and only then is salaries created
-- and filled. (Migration 008 documents why the pragma escapes do not work from
-- inside the migration runner's transaction.)

-- The old per-month money, held aside. No keys, no constraints: it exists for
-- the length of this migration and nothing points at it.
CREATE TABLE _salary_staging AS
SELECT id AS job_id, accounting_month, salary_cents, job_date, status, is_demo,
       created_by, created_at, updated_by, updated_at
  FROM jobs;

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference        TEXT NOT NULL UNIQUE,
  ssn_id           INTEGER NOT NULL REFERENCES org_units(id),
  title            TEXT NOT NULL,
  client_name      TEXT,
  -- How the hiring company engages this SSN. 'w2' withholds tax before
  -- crediting; '1099' normally credits the invoice in full.
  tax_category     TEXT NOT NULL DEFAULT '1099' CHECK (tax_category IN ('w2','1099')),
  -- Held from each salary's CREDITED amount, not from the invoice. 1000 = 10%.
  tax_hold_bps     INTEGER NOT NULL DEFAULT 0
                     CHECK (tax_hold_bps >= 0 AND tax_hold_bps <= 10000),
  joining_date     TEXT NOT NULL,
  -- An engagement that has ended keeps its history but takes no new salaries.
  -- There is no draft/void here any more: a salary carries that.
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes            TEXT,
  attachment_id    INTEGER REFERENCES attachments(id),
  is_demo          INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL
);

INSERT INTO jobs_new
  (id, reference, ssn_id, title, client_name, tax_category, tax_hold_bps,
   joining_date, is_active, notes, attachment_id, is_demo,
   created_by, created_at, updated_by, updated_at)
SELECT
   id, reference, ssn_id, title, client_name,
   '1099',                        -- nothing was withheld in the old model
   tax_rate_bps,                  -- the per-job rate carries straight over
   job_date,                      -- the old job date becomes the joining date
   CASE WHEN status = 'void' THEN 0 ELSE 1 END,
   notes, attachment_id, is_demo,
   created_by, created_at, updated_by, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_ssn ON jobs(ssn_id, is_active);
CREATE INDEX idx_jobs_joining ON jobs(joining_date);

-- ------------------------------------------------------------ 2. salaries --

CREATE TABLE salaries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reference              TEXT NOT NULL UNIQUE,
  job_id                 INTEGER NOT NULL REFERENCES jobs(id),
  accounting_month       TEXT NOT NULL,
  -- What was billed.
  invoice_amount_cents   INTEGER NOT NULL CHECK (invoice_amount_cents >= 0),
  -- What actually arrived. The difference is what the hiring company withheld.
  credited_amount_cents  INTEGER NOT NULL CHECK (credited_amount_cents >= 0),
  credit_date            TEXT,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft','active','void')),
  notes                  TEXT,
  attachment_id          INTEGER REFERENCES attachments(id),
  is_demo                INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_by             INTEGER REFERENCES users(id),
  created_at             TEXT NOT NULL,
  updated_by             INTEGER REFERENCES users(id),
  updated_at             TEXT NOT NULL,

  -- More cannot arrive than was billed, or the withheld amount goes negative
  -- and the whole chain stops meaning anything.
  CHECK (credited_amount_cents <= invoice_amount_cents)
);

-- One salary per old job, for the month that job carried. Nothing was
-- withheld, so invoice and credited are the same figure.
INSERT INTO salaries
  (reference, job_id, accounting_month, invoice_amount_cents, credited_amount_cents,
   credit_date, status, notes, is_demo, created_by, created_at, updated_by, updated_at)
SELECT
   'SAL-' || replace(substr(t.accounting_month, 1, 7), '-', '') || '-'
     || substr('0000' || CAST(ROW_NUMBER() OVER (
          PARTITION BY substr(t.accounting_month, 1, 7) ORDER BY t.job_id) AS TEXT), -4),
   t.job_id,
   t.accounting_month,
   t.salary_cents,
   t.salary_cents,
   t.job_date,
   t.status,
   NULL,
   t.is_demo,
   t.created_by, t.created_at, t.updated_by, t.updated_at
FROM _salary_staging t;

DROP TABLE _salary_staging;

CREATE INDEX idx_salaries_job_month ON salaries(job_id, accounting_month, status);
CREATE INDEX idx_salaries_month ON salaries(accounting_month, status);
CREATE INDEX idx_salaries_credit_date ON salaries(credit_date);
