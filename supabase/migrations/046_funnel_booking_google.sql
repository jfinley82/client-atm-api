-- Funnel Builder Phase 3b — booking creates the real event on the coach's Google
-- Calendar. Verified against the live DB: funnels has no booking_questions;
-- bookings has coach_user_id (043) but no google_event_id/meeting_url; the active
-- unique index is uq_bookings_active_start on (start_time) WHERE status='active'.

-- Per-funnel booking questions (same { id, label, type, required, options?, order }
-- shape as the global validator), living as jsonb like landing_page/booking_page.
alter table funnels add column if not exists booking_questions jsonb default '[]'::jsonb;

-- Google-path booking columns. The legacy zoom_join_url stays for the shared path.
alter table bookings add column if not exists google_event_id text;
alter table bookings add column if not exists meeting_url text;

-- Concurrency backstop, now PER COACH. The old index was global on start_time, so
-- two different coaches couldn't hold the same clock time. Swap it to
-- (coach_user_id, start_time) for active rows. NULLS NOT DISTINCT (Postgres 15+)
-- is REQUIRED: legacy shared-path bookings have coach_user_id = NULL, and without
-- it two NULL-coach rows at the same time would NOT collide — regressing the
-- shared-calendar double-book protection. With it, all NULL-coach rows still
-- collide on start_time, while distinct coaches can book the same time.
drop index if exists uq_bookings_active_start;
create unique index if not exists uq_bookings_active_coach_start
  on bookings (coach_user_id, start_time) nulls not distinct
  where status = 'active';
