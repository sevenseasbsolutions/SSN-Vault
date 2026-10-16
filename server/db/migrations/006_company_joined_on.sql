-- ============================================================================
-- 006_company_joined_on
--
-- When the engagement with a hiring company started.
--
-- A company record already says whose profile the work sits under and how it is
-- taxed; the date the work began is the other fact worth keeping, and the one
-- nothing else in the system can infer. The first salary recorded against a
-- company is not the same thing: work usually starts before the first payment
-- arrives, and a company can be set up in advance of any payment at all.
--
-- Date-only, like every other date here, so it can never shift across a
-- timezone boundary. NULL on companies recorded before this existed: the date
-- is unknown rather than assumed, and the interface asks for it on the next
-- edit instead of inventing one.
-- ============================================================================

ALTER TABLE companies ADD COLUMN joined_on TEXT;   -- 'YYYY-MM-DD'
