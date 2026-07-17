-- Native in-app calendar bookings (replaces the embedded Zoom scheduler
-- iframe). A member/prospect picks a slot, the backend creates a Zoom meeting
-- via the Meetings API, and one row is stored here. Times are UTC; the
-- frontend renders in the visitor's timezone.
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: discovery-call bookers may not be logged-in members. Set null
  -- (not cascade-delete) so a deleted member's booking history survives.
  user_id uuid references users(id) on delete set null,
  name text not null,
  email text not null,
  zoom_meeting_id text,
  zoom_join_url text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'active' check (status in ('active', 'canceled')),
  created_at timestamptz default now()
);

create index if not exists idx_bookings_start_time on bookings (start_time);

-- Double-booking backstop at the DB level: at most one ACTIVE booking per
-- start time, so two concurrent requests that both pass the app-level
-- "slot still open" check can't both reserve the same slot — the second
-- insert fails with 23505 and the endpoint returns 409. A canceled booking
-- frees the slot (partial index only covers active rows).
create unique index if not exists uq_bookings_active_start
  on bookings (start_time) where status = 'active';
