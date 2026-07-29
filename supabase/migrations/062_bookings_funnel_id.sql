-- Attribute a booking to the funnel it came from.
--
-- bookings has never carried a funnel reference. The Google path sets
-- coach_user_id (the funnel owner), and the legacy/native path deliberately
-- leaves even that NULL because it was originally the single shared calendar. So
-- there was no way to answer "which calls are booked on THIS funnel" — which is
-- why the dashboard's Upcoming Calls panel had no source and read empty while the
-- KPI (counted from funnel_events) correctly showed 1.
--
-- coach_user_id is not a substitute: it is per COACH, so a coach with two funnels
-- would see each funnel's calls on the other's dashboard.
alter table bookings add column if not exists funnel_id uuid references funnels(id) on delete set null;

-- The dashboard query is (funnel_id, status, start_time) — upcoming active calls
-- for one funnel, in time order.
create index if not exists idx_bookings_funnel_start on bookings (funnel_id, start_time);

comment on column bookings.funnel_id is
  'Funnel this booking came from, when it originated on a funnel booking page. NULL for the legacy shared (non-funnel) calendar.';

-- One-time backfill for bookings taken before the column existed.
--
-- Deliberately conservative: only attribute a booking when its email matches a
-- funnel_leads row for EXACTLY ONE funnel. A booker whose email appears as a lead
-- on several funnels is genuinely ambiguous, and guessing would put someone
-- else's call on a coach's dashboard — worse than leaving it unattributed.
update bookings b
set funnel_id = sub.funnel_id
from (
  -- array_agg(distinct ...)[1] rather than min(): Postgres has no min(uuid),
  -- and the HAVING below already guarantees there is exactly one to pick.
  select lower(l.email) as email, (array_agg(distinct l.funnel_id))[1] as funnel_id
  from funnel_leads l
  group by lower(l.email)
  having count(distinct l.funnel_id) = 1
) sub
where b.funnel_id is null
  and lower(b.email) = sub.email;
