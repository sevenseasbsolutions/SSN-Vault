-- ============================================================================
-- 002_company_tax_scope
--
-- Adds two things to the tax reserve:
--
--   * `company` scope, so a reserve rate can follow a client contract. An
--     effective-dated company policy expires on its own when the contract ends.
--   * `percent_of_gross` basis, a percentage of what the client actually pays.
--     This is the right basis for W2-style withholding, which is computed on
--     gross pay, and it needs no guess about which expenses earned which
--     company's income.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt and its rows
-- copied across. Existing policies keep their id, scope and rate untouched.
-- ============================================================================

CREATE TABLE tax_reserve_policies_v2 (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  scope_type         TEXT NOT NULL CHECK (scope_type IN ('global','pool','partner','company')),
  pool_id            INTEGER REFERENCES distribution_pools(id),
  partner_id         INTEGER REFERENCES partners(id),
  company_id         INTEGER REFERENCES companies(id),
  basis              TEXT NOT NULL
                     CHECK (basis IN ('percent_of_net','percent_of_gross','fixed','manual','none')),
  percent_bps        INTEGER,
  fixed_amount_cents INTEGER,
  tax_year           INTEGER,
  effective_from     TEXT NOT NULL,              -- accounting month start
  effective_to       TEXT,                       -- accounting month start, NULL = open ended
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  note               TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL,
  CHECK (basis NOT IN ('percent_of_net','percent_of_gross') OR percent_bps IS NOT NULL),
  CHECK (basis <> 'fixed' OR fixed_amount_cents IS NOT NULL),
  -- A scope must name the thing it applies to.
  CHECK (scope_type <> 'pool'    OR pool_id    IS NOT NULL),
  CHECK (scope_type <> 'partner' OR partner_id IS NOT NULL),
  CHECK (scope_type <> 'company' OR company_id IS NOT NULL),
  -- A company or partner slice is measured on gross income, because expenses
  -- are allocated to pools, partners and the business -- never to a company --
  -- so a per-company "net" would be an invented apportionment.
  CHECK (scope_type NOT IN ('partner','company') OR basis <> 'percent_of_net')
);

INSERT INTO tax_reserve_policies_v2 (
  id, name, scope_type, pool_id, partner_id, company_id, basis, percent_bps,
  fixed_amount_cents, tax_year, effective_from, effective_to, is_active, note,
  created_by, created_at, updated_by, updated_at
)
SELECT
  id, name, scope_type, pool_id, partner_id, NULL,
  -- A pre-existing partner-scoped policy was accepted but never applied by the
  -- engine. Moving it to the gross basis is what makes it take effect, and is
  -- the only basis a partner slice can be measured on.
  CASE WHEN scope_type = 'partner' AND basis = 'percent_of_net'
       THEN 'percent_of_gross' ELSE basis END,
  percent_bps, fixed_amount_cents, tax_year, effective_from, effective_to,
  is_active, note, created_by, created_at, updated_by, updated_at
FROM tax_reserve_policies;

DROP TABLE tax_reserve_policies;

ALTER TABLE tax_reserve_policies_v2 RENAME TO tax_reserve_policies;

CREATE INDEX IF NOT EXISTS idx_tax_policy_scope
  ON tax_reserve_policies(scope_type, pool_id, partner_id, company_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_tax_policy_company
  ON tax_reserve_policies(company_id, effective_from) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_policy_partner
  ON tax_reserve_policies(partner_id, effective_from) WHERE partner_id IS NOT NULL;

-- The reserve is now a sum of slices rather than one rate on the pool's net,
-- so a run records which policy produced which part of it.
ALTER TABLE distribution_runs ADD COLUMN tax_breakdown_json TEXT;
