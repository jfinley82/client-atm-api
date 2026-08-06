-- The timezone the visitor booked in.
--
-- A real column rather than another custom_answers entry because every booking
-- has one, it is not an answer to anything, and a coach reading a booking later
-- needs to know what the visitor thought they were agreeing to. Reconstructing
-- that from an IP or a guess is worse than storing one string.
--
-- Nullable on purpose: every booking made before this column existed has no
-- answer, and a caller that sends no timezone must keep working unchanged. NULL
-- means "not captured" and renders as UTC, exactly as it does today — see
-- bookingTimeLabel in lib/bookingTimezone.ts.
--
-- text, not an enum or a FK: IANA revises the zone database, and widening a
-- CHECK is one migration while widening an enum type is not. Validity is
-- enforced at the write path by Intl, which is always current with the runtime.

alter table bookings add column if not exists timezone text;

comment on column bookings.timezone is
  'IANA zone name the visitor selected when booking (e.g. America/Chicago). NULL for bookings made before capture existed, or when the caller sent none — those render as UTC.';
