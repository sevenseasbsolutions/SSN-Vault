-- ============================================================================
-- 001_init -- Partner Payout, Expense & Profit Distribution Management System
--
-- MONEY:   every monetary column is an INTEGER number of minor units (cents).
-- PERCENT: every percentage column is an INTEGER number of basis points
--          (bps); 3000 bps = 30.00%.
-- DATES:   accounting_month is the month-start date 'YYYY-MM-01'. All other
--          date columns are date-only TEXT 'YYYY-MM-DD'. Timestamps are ISO
--          8601 UTC strings. Date-only values are never timezone converted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  INTEGER,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','partner','editor','viewer')),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_pw INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pw IN (0,1)),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

-- Explicit per-user grants and denials layered over the role defaults.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  effect     TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission)
);

-- Row-level access scopes. A user with no scope row of a given type is
-- unscoped for that type ONLY if their role is owner; every other role is
-- restricted to the scopes listed here.
CREATE TABLE IF NOT EXISTS user_scopes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('partner','partner_profile','company','pool')),
  scope_id   INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  csrf_token  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ----------------------------------------------------------------- parties --

CREATE TABLE IF NOT EXISTS distribution_pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_name ON distribution_pools(lower(name));

CREATE TABLE IF NOT EXISTS partners (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_code       TEXT NOT NULL,              -- internal partner id, never the SSN
  name               TEXT NOT NULL,
  email              TEXT,
  phone              TEXT,
  pool_id            INTEGER NOT NULL REFERENCES distribution_pools(id),
  default_share_bps  INTEGER NOT NULL DEFAULT 0 CHECK (default_share_bps >= 0 AND default_share_bps <= 10000),
  tax_policy_id      INTEGER,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_code ON partners(lower(partner_code));
CREATE INDEX IF NOT EXISTS idx_partners_pool ON partners(pool_id);

-- A partner may hold several payment profiles. SSN is NEVER stored in full;
-- only the last four digits, and only where the business workflow requires it.
CREATE TABLE IF NOT EXISTS partner_profiles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id   INTEGER NOT NULL REFERENCES partners(id),
  profile_code TEXT NOT NULL,
  label        TEXT NOT NULL,
  ssn_last4    TEXT CHECK (ssn_last4 IS NULL OR ssn_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_code ON partner_profiles(lower(profile_code));
CREATE INDEX IF NOT EXISTS idx_profiles_partner ON partner_profiles(partner_id);

-- Effective-dated share agreements. The agreement in force for an accounting
-- month is the one whose [effective_from, effective_to] covers that month.
CREATE TABLE IF NOT EXISTS partner_share_agreements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id     INTEGER NOT NULL REFERENCES partners(id),
  pool_id        INTEGER NOT NULL REFERENCES distribution_pools(id),
  share_bps      INTEGER NOT NULL CHECK (share_bps >= 0 AND share_bps <= 10000),
  effective_from TEXT NOT NULL,                  -- accounting month start
  effective_to   TEXT,                           -- accounting month start, NULL = open ended
  note           TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agreements_lookup
  ON partner_share_agreements(pool_id, partner_id, effective_from);

CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  identifier    TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name ON companies(lower(name));

-- ------------------------------------------------------------- attachments --

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  checksum     TEXT,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);

-- ------------------------------------------------------------------ income --

CREATE TABLE IF NOT EXISTS payouts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference           TEXT NOT NULL UNIQUE,
  -- Month, pay period and credit date are four independent facts. Nothing in
  -- this application derives one from another.
  accounting_month    TEXT NOT NULL,             -- 'YYYY-MM-01'
  pay_period_from     TEXT NOT NULL,             -- 'YYYY-MM-DD'
  pay_period_to       TEXT NOT NULL,             -- 'YYYY-MM-DD'
  credit_date         TEXT NOT NULL,             -- 'YYYY-MM-DD', real receipt date
  amount_cents        INTEGER NOT NULL,
  company_id          INTEGER NOT NULL REFERENCES companies(id),
  partner_profile_id  INTEGER NOT NULL REFERENCES partner_profiles(id),
  partner_id          INTEGER NOT NULL REFERENCES partners(id),
  pool_id             INTEGER NOT NULL REFERENCES distribution_pools(id),
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','void')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified','verified','disputed')),
  attachment_id       INTEGER REFERENCES attachments(id),
  is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  void_reason         TEXT,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TEXT NOT NULL,
  CHECK (pay_period_from <= pay_period_to),
  CHECK (accounting_month LIKE '____-__-01')
);
CREATE INDEX IF NOT EXISTS idx_payouts_month    ON payouts(accounting_month, status);
CREATE INDEX IF NOT EXISTS idx_payouts_credit   ON payouts(credit_date, status);
CREATE INDEX IF NOT EXISTS idx_payouts_period   ON payouts(pay_period_from, pay_period_to);
CREATE INDEX IF NOT EXISTS idx_payouts_profile  ON payouts(partner_profile_id, accounting_month);
CREATE INDEX IF NOT EXISTS idx_payouts_partner  ON payouts(partner_id, accounting_month);
CREATE INDEX IF NOT EXISTS idx_payouts_company  ON payouts(company_id, accounting_month);
CREATE INDEX IF NOT EXISTS idx_payouts_pool     ON payouts(pool_id, accounting_month, status);

-- ---------------------------------------------------------------- expenses --

CREATE TABLE IF NOT EXISTS expense_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name ON expense_categories(lower(name));

CREATE TABLE IF NOT EXISTS expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference        TEXT NOT NULL UNIQUE,
  expense_date     TEXT NOT NULL,                -- when the cost was incurred
  accounting_month TEXT NOT NULL,                -- which accounting month it belongs to
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  category_id      INTEGER NOT NULL REFERENCES expense_categories(id),
  description      TEXT,
  vendor_company_id INTEGER REFERENCES companies(id),
  payment_method   TEXT,
  payment_reference TEXT,
  status           TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','void')),
  attachment_id    INTEGER REFERENCES attachments(id),
  is_demo          INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  void_reason      TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL,
  CHECK (accounting_month LIKE '____-__-01')
);
CREATE INDEX IF NOT EXISTS idx_expenses_month    ON expenses(accounting_month, status);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(expense_date, status);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_vendor   ON expenses(vendor_company_id);

-- An expense is split into one or more allocations whose amounts sum EXACTLY
-- to the expense amount. This is what guarantees an expense is deducted once
-- and once only, however many targets it is shared across.
--
--   target_type 'pool'     -> reduces that pool's distributable balance
--   target_type 'partner'  -> charged directly to that partner's own share
--   target_type 'business' -> owner/business cost, reduces no pool
CREATE TABLE IF NOT EXISTS expense_allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('business','partner','pool')),
  partner_id   INTEGER REFERENCES partners(id),
  pool_id      INTEGER REFERENCES distribution_pools(id),
  percent_bps  INTEGER,
  amount_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK ((target_type = 'partner' AND partner_id IS NOT NULL)
      OR (target_type = 'pool'    AND pool_id    IS NOT NULL)
      OR (target_type = 'business'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_expense ON expense_allocations(expense_id);
CREATE INDEX IF NOT EXISTS idx_alloc_pool    ON expense_allocations(pool_id);
CREATE INDEX IF NOT EXISTS idx_alloc_partner ON expense_allocations(partner_id);

-- ------------------------------------------------------------- tax reserve --

CREATE TABLE IF NOT EXISTS tax_reserve_policies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  scope_type         TEXT NOT NULL CHECK (scope_type IN ('global','pool','partner')),
  pool_id            INTEGER REFERENCES distribution_pools(id),
  partner_id         INTEGER REFERENCES partners(id),
  basis              TEXT NOT NULL CHECK (basis IN ('percent_of_net','fixed','manual','none')),
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
  CHECK (basis <> 'percent_of_net' OR percent_bps IS NOT NULL),
  CHECK (basis <> 'fixed' OR fixed_amount_cents IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tax_policy_scope
  ON tax_reserve_policies(scope_type, pool_id, partner_id, effective_from);

-- A manual reserve amount pinned to one (pool, month). Overrides the policy.
CREATE TABLE IF NOT EXISTS tax_reserve_overrides (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id          INTEGER NOT NULL REFERENCES distribution_pools(id),
  accounting_month TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  reason           TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  UNIQUE (pool_id, accounting_month)
);

-- Running reserve ledger. The UNIQUE(source_type, source_id, entry_type) index
-- is what prevents the same reserve transaction being recorded twice when a
-- distribution is recalculated.
CREATE TABLE IF NOT EXISTS tax_reserve_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('addition','adjustment','withdrawal')),
  pool_id          INTEGER NOT NULL REFERENCES distribution_pools(id),
  accounting_month TEXT NOT NULL,
  tax_year         INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL,             -- signed: additions +, withdrawals -
  reference        TEXT,
  note             TEXT,
  source_type      TEXT NOT NULL DEFAULT 'manual',
  source_id        INTEGER,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_source
  ON tax_reserve_ledger(source_type, source_id, entry_type)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reserve_month ON tax_reserve_ledger(pool_id, accounting_month);
CREATE INDEX IF NOT EXISTS idx_reserve_year  ON tax_reserve_ledger(tax_year);

-- -------------------------------------------------------------- accounting --

CREATE TABLE IF NOT EXISTS accounting_periods (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id          INTEGER NOT NULL REFERENCES distribution_pools(id),
  accounting_month TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized','reopened')),
  finalized_by     INTEGER REFERENCES users(id),
  finalized_at     TEXT,
  reopened_by      INTEGER REFERENCES users(id),
  reopened_at      TEXT,
  reopen_reason    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (pool_id, accounting_month)
);

CREATE TABLE IF NOT EXISTS deficit_carryforwards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id          INTEGER NOT NULL REFERENCES distribution_pools(id),
  origin_month     TEXT NOT NULL,
  applied_month    TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,             -- stored positive, applied as a reduction
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','cancelled')),
  note             TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  UNIQUE (pool_id, origin_month)
);
CREATE INDEX IF NOT EXISTS idx_carryforward_applied
  ON deficit_carryforwards(pool_id, applied_month, status);

-- ----------------------------------------------------------- distributions --

CREATE TABLE IF NOT EXISTS distribution_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id               INTEGER NOT NULL REFERENCES distribution_pools(id),
  accounting_month      TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','calculated','pending_approval','approved','reversed')),
  gross_income_cents    INTEGER NOT NULL DEFAULT 0,
  pool_expenses_cents   INTEGER NOT NULL DEFAULT 0,
  partner_charges_cents INTEGER NOT NULL DEFAULT 0,
  carryforward_cents    INTEGER NOT NULL DEFAULT 0,
  net_before_tax_cents  INTEGER NOT NULL DEFAULT 0,
  tax_reserve_cents     INTEGER NOT NULL DEFAULT 0,
  distributable_cents   INTEGER NOT NULL DEFAULT 0,
  partner_total_cents   INTEGER NOT NULL DEFAULT 0,
  owner_share_cents     INTEGER NOT NULL DEFAULT 0,
  tax_basis             TEXT,
  snapshot_json         TEXT,
  calculated_by         INTEGER REFERENCES users(id),
  calculated_at         TEXT,
  approved_by           INTEGER REFERENCES users(id),
  approved_at           TEXT,
  reversed_by           INTEGER REFERENCES users(id),
  reversed_at           TEXT,
  reverse_reason        TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (pool_id, accounting_month)
);
CREATE INDEX IF NOT EXISTS idx_runs_month ON distribution_runs(accounting_month, status);

CREATE TABLE IF NOT EXISTS partner_distributions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 INTEGER NOT NULL REFERENCES distribution_runs(id) ON DELETE CASCADE,
  partner_id             INTEGER NOT NULL REFERENCES partners(id),
  pool_id                INTEGER NOT NULL REFERENCES distribution_pools(id),
  accounting_month       TEXT NOT NULL,
  share_bps              INTEGER NOT NULL,
  eligible_net_cents     INTEGER NOT NULL DEFAULT 0,
  tax_allocation_cents   INTEGER NOT NULL DEFAULT 0,
  calculated_share_cents INTEGER NOT NULL DEFAULT 0,
  direct_charges_cents   INTEGER NOT NULL DEFAULT 0,
  adjustment_cents       INTEGER NOT NULL DEFAULT 0,
  payable_cents          INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'calculated'
                         CHECK (status IN ('draft','calculated','pending_approval','approved',
                                           'partially_paid','paid','adjusted','reversed')),
  adjustment_reason      TEXT,
  approved_by            INTEGER REFERENCES users(id),
  approved_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (run_id, partner_id)
);
CREATE INDEX IF NOT EXISTS idx_pdist_partner ON partner_distributions(partner_id, accounting_month);
CREATE INDEX IF NOT EXISTS idx_pdist_status  ON partner_distributions(status);

-- A real bank transfer. Recorded separately from the calculated share, and
-- never created automatically by a calculation.
CREATE TABLE IF NOT EXISTS distribution_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id INTEGER NOT NULL REFERENCES partner_distributions(id) ON DELETE CASCADE,
  partner_id      INTEGER NOT NULL REFERENCES partners(id),
  amount_cents    INTEGER NOT NULL,
  payment_date    TEXT NOT NULL,
  method          TEXT,
  reference       TEXT,
  note            TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','void')),
  void_reason     TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_dist ON distribution_payments(distribution_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idem
  ON distribution_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- --------------------------------------------------------------- audit log --

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  user_label  TEXT,
  reason      TEXT,
  changes_json TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_log(created_at);
