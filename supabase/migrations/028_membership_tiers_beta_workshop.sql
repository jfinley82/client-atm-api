-- Membership model Phase 1: adds 'beta' and 'workshop' as accepted
-- membership_tier values alongside the existing free/low_ticket/full.
-- The column has been free TEXT since 005_membership_tiers.sql (no
-- constraint), so this both formalizes the original three values and admits
-- the two new ones — same tighten-after-the-fact idiom as
-- 027_events_type_check.sql. All existing rows are free/low_ticket/full
-- (verified during the membership recon), so this cannot fail on existing
-- data.
alter table users drop constraint if exists users_membership_tier_check;
alter table users add constraint users_membership_tier_check
  check (membership_tier in ('free', 'low_ticket', 'full', 'beta', 'workshop'));
