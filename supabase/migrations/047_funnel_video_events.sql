-- Funnel Builder Phase 4 — tracked video milestones + video KPIs.
-- Verified against the migration history (044 is the current CHECK): the
-- funnel_events CHECK is landing_view/training_view/signup/booking_click/booked/
-- closed, and funnel_events has no metadata column (040 created it with only
-- id/funnel_id/lead_id/event_type/created_at).

-- 1) Allow the two CLIENT-reported video engagement events. DROP + re-ADD,
-- mirroring the constraint-swap in 042/044. ENGAGEMENT_EVENT_TYPES already lists
-- both, so once these rows exist with a lead_id they surface on the lead's
-- activity feed automatically — no read-path change needed.
alter table funnel_events drop constraint if exists funnel_events_event_type_check;
alter table funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'landing_view', 'training_view', 'signup', 'booking_click', 'booked', 'closed',
    'video_watched', 'video_completed'
  ]));

-- 2) Per-event metadata for the video beacons: { session_id, percent }. A jsonb
-- column (constant default → a metadata-only add in PG, no table rewrite) rather
-- than a new table. session_id is the per-page-view key that both DEDUPES the
-- milestones and lets the KPI reduce each viewing session to its furthest
-- percent; percent is the milestone (25/50/75/100). These milestone events are
-- the whole store for v1 — a dedicated per-lead furthest-percent table is a later
-- refinement, only if drop-off precision ever outgrows what the metadata gives.
alter table funnel_events add column if not exists metadata jsonb default '{}'::jsonb;

-- 3) Dedup backstop so a replayed beacon can't inflate counts: at most one row
-- per (funnel, session, percent) for video events. A replay hits this unique
-- index and the endpoint treats the 23505 as a benign duplicate (still 200).
-- Partial + NULL-guarded so it governs ONLY video rows that carry a session_id —
-- server-side page views and pre-Phase-4 rows are untouched.
create unique index if not exists uq_funnel_events_video_milestone
  on funnel_events (funnel_id, (metadata->>'session_id'), (metadata->>'percent'))
  where event_type in ('video_watched', 'video_completed')
    and metadata->>'session_id' is not null;
