-- Funnel Builder Phase 5b — event-driven nurture sender.
-- Verified against the migration history: funnels.watch_threshold_pct already
-- exists (added in 040, default 50); the ADD below is idempotent and only a
-- safety net. funnel_email_sends (048) already carries the scheduled_at column
-- and the queued/sent/canceled/failed status this phase drives.

-- Per-funnel COPY of the nurture (pre-watch) and book-a-call (post-watch)
-- sequences, seeded at funnel creation from the coach's mtm_generations
-- (emails / book_a_call_emails). A per-funnel copy means builder edits to a
-- funnel's emails never mutate the master generation, and each send reads the
-- funnel's own frozen copy. Same MtEmail shape { email_number, send_timing,
-- subject, body } stored as jsonb like landing_page/booking_page.
alter table funnels add column if not exists nurture_emails jsonb default '[]'::jsonb;
alter table funnels add column if not exists book_a_call_emails jsonb default '[]'::jsonb;

-- Watch threshold that pivots a lead from the nurture track to the book-a-call
-- track (an attributed video_watched at >= this percent). Already present from
-- 040; kept here idempotently so this migration is self-describing.
alter table funnels add column if not exists watch_threshold_pct int default 50;

-- Atomic pivot guard. When a watch crosses the threshold, the pivot does a
-- compare-and-swap `update ... set nurture_pivoted=true where id=? and
-- nurture_pivoted=false` and proceeds only if it won the row — so two watch
-- beacons crossing the threshold near-simultaneously (e.g. the 50% and 75%
-- milestones) can't both cancel-nurture-and-schedule-book-a-call. One wins.
alter table funnel_leads add column if not exists nurture_pivoted boolean not null default false;
