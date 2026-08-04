-- Office Hours & Events: the unseen-events nav badge.
--
-- One row per user holding only the MOST RECENT view, not a visit log — the
-- badge only ever asks "has anything been added since you last looked", so a
-- history of every visit would be rows nothing reads. user_id is the primary
-- key rather than a separate id + unique index, which is what makes the
-- mark-viewed write a plain upsert on conflict.
--
-- No default row is created for existing members. A user with no row has
-- never opened the page, which the unseen check treats as "last viewed at the
-- beginning of time" — so anyone with at least one event on the calendar sees
-- the badge until they open it once.
create table if not exists event_calendar_views (
  user_id uuid primary key references users(id) on delete cascade,
  last_viewed_at timestamptz not null default now()
);

-- The badge compares against max(events.created_at). Indexed because that
-- aggregate runs on every shell/nav render, which is the most frequent read
-- in the app — far more often than the calendar page itself is opened.
create index if not exists idx_events_created_at on events (created_at);
