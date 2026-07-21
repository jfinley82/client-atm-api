-- Add 'closed' to funnel_leads.status for the Phase 2 CRM close step.
--
-- The live constraint (verified against the prod DB) allows
-- lead/watching/booked/showed/no_show/sold and NOT 'closed'. Migration 040's
-- CREATE wrote a different (lead/booked/closed) set but was a silent no-op
-- against the pre-existing table (see 041), so the real set is the six above.
-- The funnel flow uses lead -> booked -> closed, so add 'closed' while keeping
-- every existing value. DROP + re-ADD mirrors the constraint-swap pattern used
-- in 039 (saved_outputs tool_type).
alter table funnel_leads drop constraint if exists funnel_leads_status_check;
alter table funnel_leads add constraint funnel_leads_status_check
  check (status = any (array[
    'lead', 'watching', 'booked', 'showed', 'no_show', 'sold', 'closed'
  ]));
