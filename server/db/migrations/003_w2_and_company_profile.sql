-- ============================================================================
-- 003_w2_and_company_profile
--
-- The remote-work arrangement this system actually serves: a US partner's
-- profile is used to land a job with a hiring company, the company pays into
-- that profile, and part of what it pays never arrives because the company has
-- already paid it as tax under a W2 arrangement.
--
-- Three facts had nowhere to live:
--
--   * which profile a company's work sits under, and whether that engagement
--     is W2 or 1099;
--   * what the company invoiced, as distinct from what was credited;
--   * how much tax the company paid on our behalf -- money that is real, is
--     already spent, and must never be counted as income or as distributable.
--
-- `amount_cents` keeps its meaning throughout: the money that actually arrived.
-- Every income, pool and distribution figure is still built on it, so nothing
-- downstream has to be re-derived. The invoice and the W2 figure sit alongside
-- it for reconciliation and reporting.
-- ============================================================================

-- Which profile the engagement sits under, and how it is taxed. Both are NULL
-- on companies recorded before this migration; the interface asks for them on
-- the next edit rather than inventing an answer.
ALTER TABLE companies ADD COLUMN partner_profile_id INTEGER REFERENCES partner_profiles(id);
ALTER TABLE companies ADD COLUMN tax_category TEXT;   -- 'w2' | '1099'

CREATE INDEX IF NOT EXISTS idx_companies_profile
  ON companies(partner_profile_id) WHERE partner_profile_id IS NOT NULL;

-- What the company invoiced, and what it paid as tax on our behalf.
--
--   invoice_amount_cents  what the company billed/sent      (1000)
--   amount_cents          what was credited to the profile   (800)
--   w2_paid_cents         tax the company already paid       (200)
--
-- They reconcile: invoice = credited + W2 paid. Stored rather than derived so a
-- later correction to one is visible as a change rather than silently altering
-- a historical total.
ALTER TABLE payouts ADD COLUMN invoice_amount_cents INTEGER;
ALTER TABLE payouts ADD COLUMN w2_paid_cents INTEGER NOT NULL DEFAULT 0;

-- Existing salaries were recorded as a single credited figure with no company
-- tax, which is exactly the 1099 case: invoiced equals credited, nothing was
-- withheld. That is a faithful reading of what was recorded, not a guess.
UPDATE payouts SET invoice_amount_cents = amount_cents WHERE invoice_amount_cents IS NULL;

CREATE INDEX IF NOT EXISTS idx_payouts_w2
  ON payouts(accounting_month, w2_paid_cents) WHERE w2_paid_cents > 0;
