-- ============================================================================
-- 005_partner_own_earnings
--
-- A partner is paid a share of what came in through their own profiles, not a
-- share of everything the pool earned. A saved distribution therefore has to
-- record the basis of each share, not only its result: what that partner
-- earned, what share of the shared costs they bore, and the net those two
-- leave. Without it a statement can show the payment but not how it arose,
-- and a recalculation months later cannot be checked against the original.
--
-- `eligible_net_cents` already existed and already means "the net this partner
-- is eligible on". It used to be filled with the whole pool's net, which never
-- matched its name; from now on it carries the partner's own net, the same
-- figure as `own_net_cents`. Rows written before this keep the pool net they
-- were actually calculated against -- that is what happened, so it is what the
-- record says.
-- ============================================================================

ALTER TABLE partner_distributions ADD COLUMN own_income_cents        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partner_distributions ADD COLUMN own_expense_share_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partner_distributions ADD COLUMN own_net_cents           INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_partner_dist_own
  ON partner_distributions(partner_id, accounting_month);
