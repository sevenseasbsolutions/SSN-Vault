-- ============================================================================
-- 004_partner_default_profile
--
-- A partner with no payment profile cannot be used for anything.
--
-- A profile is what a hiring company's work is landed on and what a salary is
-- recorded against. Creating a partner used to create a profile only when the
-- optional profile fields were filled in, so a partner added without them was
-- invisible everywhere it mattered: absent from the profile list when adding a
-- company, and unselectable when recording a salary. The partner looked saved
-- and was, in practice, unusable.
--
-- Partner creation now always makes a first profile. This gives the partners
-- created before that the same thing, so nothing has to be re-entered.
--
-- Only partners with no profile at all are touched, and nothing else about them
-- changes. The profile is named after the partner and coded from their internal
-- ID, exactly as a newly created one would be, and can be renamed afterwards.
-- ============================================================================

INSERT INTO partner_profiles
  (partner_id, profile_code, label, ssn_last4, is_active, notes,
   created_by, created_at, updated_by, updated_at)
SELECT
  p.id,
  p.partner_code || '-01',
  p.name || ' — primary profile',
  NULL,
  1,
  'Created automatically: this partner had no profile, so no company or salary '
    || 'could be recorded against them.',
  p.created_by,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  p.created_by,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM partners p
WHERE NOT EXISTS (
  SELECT 1 FROM partner_profiles pp WHERE pp.partner_id = p.id
);
