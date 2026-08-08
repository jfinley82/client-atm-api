-- 096_bookings_lead_id.sql
--
-- WHICH LEAD a booking was created from — recorded, not reconstructed.
--
-- Today the link between a call and the person who booked it is rebuilt at read
-- time from (funnel_id, lower(email)) — bookingKey in lib/contacts.ts. The
-- writer already knows the answer and throws it away: api/calendar/book.ts's
-- logFunnelBooked resolves the lead, hands it to the confirmation email and to
-- cancelLeadOutreach, and then inserts the booking row without it.
--
-- WHAT THE COLUMN MEANS
--
-- lead_id is the lead this booking was CREATED FROM, known at write time.
-- Nothing else. A value here is a record, never a derivation.
--
-- Nothing may resolve it from a read-time (coach, email) match. That match is
-- the lib/contacts.ts heuristic, and writing it into a column would make a
-- guessed uuid indistinguishable from a recorded one — worse than null, because
-- null is honest about not knowing while a guess is confidently wrong in a way
-- nothing downstream can detect.
--
-- This is the same sentence as the Client Programs brief §8.4, one table over:
-- discovery_call_count uses that same (coach, email) match DELIBERATELY, for
-- display, and it must never migrate into the allowance calculation. Same
-- query, opposite consequences. Right for attributing a call to a contact on
-- screen; wrong for asserting a foreign key.
--
-- THE CONSEQUENCE IS CORRECT, NOT A GAP
--
-- Coach-page bookings will carry a null lead_id forever, because there is no
-- funnel to resolve from at write time. A coach-page booking is created from no
-- lead. The person may well BE a lead somewhere in that coach's funnels, but
-- this call did not come from there — the column records PROVENANCE, not
-- IDENTITY. lib/contacts.ts keeps doing the attribution work permanently, and
-- that is not a stopgap. Anyone who later wants those rows resolved has to argue
-- that the meaning should change, not that a backfill was overdue.
--
-- funnel_id STAYS, and it is not duplication
--
-- bookings.funnel_id records which funnel produced this call at the moment it
-- was booked. lead_id -> funnel_leads.funnel_id reports which funnel that lead
-- sits in NOW. A lead can be edited, moved or deleted and the second value
-- changes while the first must not. They agree today, which is exactly the
-- condition under which a second fact looks like a derivation — do not read the
-- derive-at-read-time convention in CLAUDE.md and drop it. Secondarily, it is
-- the only funnel signal left on a row whose lead is later deleted.
--
-- ON DELETE SET NULL, NOT CASCADE. Deleting a lead must not delete the call
-- they had: the call happened, and the coach's calendar history is a record of
-- it. Cascade would silently rewrite history when someone tidies their CRM.
--
-- NULLABLE, AND IT STAYS NULLABLE. Null means "created from no lead", which is
-- the true and permanent state of 8 of the 11 rows in production today and of
-- every future coach-page booking. NOT NULL would be a claim that every call
-- comes from a funnel — exactly the assumption that broke the coach calendar.
--
-- VALIDATED IN begin; ... rollback; ON PRODUCTION BEFORE APPLYING (2026-08-08):
-- 11 bookings, 3 backfilled, 8 funnel-less left null, 0 with a funnel left null.
-- Expected 3 and got 3.

alter table bookings
  add column if not exists lead_id uuid references funnel_leads(id) on delete set null;

-- Partial: most rows are null and every reader of this column reads it for a
-- non-null value.
create index if not exists idx_bookings_lead_id on bookings (lead_id) where lead_id is not null;

-- BACKFILL — the unambiguous funnel case ONLY.
--
-- The `not exists` clause refuses any booking whose address matches two leads on
-- the same funnel rather than picking the newer one. A backfill is a one-off
-- write with no reader to correct it, so it asserts only what it is certain of;
-- the readers already have a documented tie-break for the ambiguous case and
-- keep using it.
--
-- There is deliberately NO coach-page rule here. Not deferred — excluded by the
-- definition above.
update bookings b
set lead_id = l.id
from funnel_leads l
where b.lead_id is null
  and b.funnel_id is not null
  and l.funnel_id = b.funnel_id
  and lower(btrim(l.email)) = lower(btrim(b.email))
  and not exists (
    select 1 from funnel_leads l2
    where l2.funnel_id = b.funnel_id
      and lower(btrim(l2.email)) = lower(btrim(b.email))
      and l2.id <> l.id
  );
