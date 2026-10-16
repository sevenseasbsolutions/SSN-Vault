-- ===========================================================================
-- 011: an optional pay period on a salary.
-- ===========================================================================
--
-- What stretch of work a salary covers, e.g. 21 September to 5 October. Both
-- dates are optional and either may be given without the other being useful
-- on its own, so they are nullable and only checked against each other when
-- both are present.
--
-- Deliberately NOT tied to the accounting month. A pay period routinely
-- straddles a month boundary, and the accounting month is the one that decides
-- which statement the money lands in -- see assumption 1 in
-- services/rollup.js. Nothing here changes a single figure; it is descriptive.
--
-- Plain ALTER TABLE: adding nullable columns needs no rebuild, and nothing
-- references them.

ALTER TABLE salaries ADD COLUMN pay_period_from TEXT;
ALTER TABLE salaries ADD COLUMN pay_period_to   TEXT;

-- Closed interval, so a single-day period has from = to. The ordering is
-- enforced in routes/salaries.js as well, which is where a user gets a
-- readable message instead of a constraint error; this is the backstop for
-- anything written another way.
--
-- A CHECK cannot be added to an existing table, so the guard is an index-free
-- trigger. It fires on both writes and says the same thing either way.

CREATE TRIGGER salaries_period_order_insert
BEFORE INSERT ON salaries
WHEN NEW.pay_period_from IS NOT NULL
 AND NEW.pay_period_to IS NOT NULL
 AND NEW.pay_period_to < NEW.pay_period_from
BEGIN
  SELECT RAISE(ABORT, 'pay period ends before it starts');
END;

CREATE TRIGGER salaries_period_order_update
BEFORE UPDATE ON salaries
WHEN NEW.pay_period_from IS NOT NULL
 AND NEW.pay_period_to IS NOT NULL
 AND NEW.pay_period_to < NEW.pay_period_from
BEGIN
  SELECT RAISE(ABORT, 'pay period ends before it starts');
END;

-- Finding the salaries whose period overlaps a range is the one query these
-- columns exist to serve.
CREATE INDEX idx_salaries_period ON salaries(pay_period_from, pay_period_to);
