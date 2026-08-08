-- Connection health for calendar_connections.
--
-- `GET /api/calendar/google/status` reported connected:true whenever a row
-- existed. It never asked Google anything, so it answered "a coach once
-- completed the OAuth flow" rather than "this calendar works". When a refresh
-- token dies, lib/funnelAvailability.ts stops subtracting Google's busy blocks
-- and every meeting MTM did not create becomes bookable — a lead takes a slot
-- the coach is already busy in and both sides believe it worked.
--
-- A TIMESTAMP, NOT A BOOLEAN. invalid_since answers HOW LONG as well as
-- WHETHER, which is what lets a later rule ("only notify once this has survived
-- N hours") be added without a second column and without restamping history.
-- It is written once, on the null -> value transition, and never overwritten —
-- see markConnectionInvalid in lib/googleCalendar.ts.
--
-- NULL MEANS HEALTHY, and no backfill runs. Existing rows are presumed working
-- because we have no evidence otherwise, and marking a live coach broken on no
-- evidence is worse than the gap this closes.

alter table public.calendar_connections
  add column if not exists invalid_since timestamptz,
  add column if not exists invalid_reason text;

-- text + CHECK rather than a Postgres enum: widening a CHECK is one migration,
-- widening an enum type is not.
--
-- These three values are exactly INVALID_REASONS in
-- lib/calendarConnectionHealth.ts, and tests/calendarConnectionHealth.test.ts
-- asserts this file and that constant agree. A constant that has drifted from
-- its constraint fails in production rather than in the gate.
--
-- There is deliberately no 'unavailable'. A 500 from Google or a timeout is not
-- evidence about the connection; recording it would make the column mean "the
-- last call didn't work", which tells a healthy coach to reconnect and teaches
-- them to ignore the warning that matters.
alter table public.calendar_connections
  drop constraint if exists calendar_connections_invalid_reason_check;
alter table public.calendar_connections
  add constraint calendar_connections_invalid_reason_check
  check (invalid_reason is null
         or invalid_reason in ('invalid_grant', 'invalid_client', 'decrypt_failed'));

-- The pair moves together or not at all. A reason with no time cannot be aged;
-- a time with no reason cannot be acted on. Either alone is a bug, and the
-- database can simply refuse it.
alter table public.calendar_connections
  drop constraint if exists calendar_connections_invalid_pair_check;
alter table public.calendar_connections
  add constraint calendar_connections_invalid_pair_check
  check ((invalid_since is null) = (invalid_reason is null));
