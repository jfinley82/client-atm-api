-- Real backend for the Office Hours / Events calendar. Confirmed via recon
-- that no events/RSVP backend existed anywhere in this repo, on any branch,
-- ever — the frontend's "RSVP Now" button was calling a path with no
-- deployed function behind it (hence the 503 with zero matching logs).
--
-- event_type is a plain TEXT column, deliberately NOT constrained to a fixed
-- CHECK enum: the frontend's exact category strings (its filter buttons —
-- "Office Hours" vs "Workshop" etc.) could not be confirmed from here (the
-- live app and its JS bundle both 403'd on direct fetch). A wrong guess at
-- an enum would reject a real category value the frontend sends; free text
-- is the safer default until those exact strings are confirmed.
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  event_type text not null,
  starts_at timestamptz not null,
  duration_minutes integer not null default 60,
  meeting_link text,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_starts_at on events (starts_at);

create table if not exists event_rsvps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, event_id)
);

create index if not exists idx_event_rsvps_user_id on event_rsvps (user_id);
create index if not exists idx_event_rsvps_event_id on event_rsvps (event_id);

-- NOTE: the two events currently hardcoded on the frontend ("Live Q&A" and
-- "Workshop: Closing Deals") are deliberately NOT seeded here. Their titles
-- are confirmed (found as literal strings in the frontend bundle), but their
-- real starts_at/duration/description/meeting_link could not be extracted
-- (same 403 blocking direct inspection) — guessing those would risk seeding
-- WRONG dates, which defeats the whole point of seeding ("the calendar
-- shouldn't visibly change the moment this ships"). Insert the real rows by
-- hand once those facts are confirmed; see the build report for the exact
-- fields needed.
