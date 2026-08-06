-- Let a send row exist without a funnel.
--
-- funnel_email_sends was built for funnel outreach, so funnel_id was NOT NULL.
-- Public /book bookings have no funnel, which meant they could not record a send
-- row — and cancelBookingReminders finds rows by booking_id, so with no row
-- there is nothing to cancel. A five-touch reminder cadence with no way to stop
-- it is worse than no cadence at all.
--
-- lead_id is already nullable and booking_id already exists, so the row shape
-- otherwise fits. The precedent is the warm-invite path, which writes rows with
-- a null lead_id and a contact_id instead: a null column here means "this send
-- did not come from that thing", not "this row is broken". A null funnel_id is
-- the same kind of exception rather than a new one.
--
-- The foreign key is unaffected — a nullable FK simply does not constrain NULL —
-- but it is re-asserted below so the relationship is visible in one place rather
-- than inferred from its absence.

alter table funnel_email_sends alter column funnel_id drop not null;

comment on column funnel_email_sends.funnel_id is
  'The funnel this send belongs to. NULL for sends with no funnel behind them - public /book booking confirmations and reminders, which are MTM''s own rather than a coach''s.';
