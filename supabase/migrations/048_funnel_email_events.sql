-- Funnel Builder Phase 5a — email open/click tracking.
-- Verified against the migration history: 047 is the current funnel_events CHECK
-- (landing_view/training_view/signup/booking_click/booked/closed/video_watched/
-- video_completed) and added the metadata jsonb column this phase reuses.

-- 1) Allow the two email engagement events. DROP + re-ADD, mirroring 042/044/047.
-- ENGAGEMENT_EVENT_TYPES already lists email_opened/email_clicked, so once these
-- rows exist with a lead_id they surface on the lead activity feed automatically.
alter table funnel_events drop constraint if exists funnel_events_event_type_check;
alter table funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'landing_view', 'training_view', 'signup', 'booking_click', 'booked', 'closed',
    'video_watched', 'video_completed', 'email_opened', 'email_clicked'
  ]));

-- 2) One row per funnel-scoped email we send, so a Resend open/click/bounce
-- webhook can resolve back to the funnel + lead by the Resend message id.
-- resend_message_id is UNIQUE (the webhook lookup key) and NULLABLE — a 5b send
-- can be pre-seeded as 'queued' with no id yet; NULLs are distinct in PG so many
-- unsent rows coexist. status covers the 5b lifecycle (queued → sent, or
-- canceled on unsubscribe, or failed).
create table if not exists funnel_email_sends (
  id uuid default gen_random_uuid() primary key,
  funnel_id uuid not null references funnels(id) on delete cascade,
  lead_id uuid references funnel_leads(id) on delete set null,
  kind text not null,
  resend_message_id text unique,
  scheduled_at timestamptz,
  status text not null default 'queued' check (status in ('queued', 'sent', 'canceled', 'failed')),
  created_at timestamptz default now()
);
create index if not exists idx_funnel_email_sends_funnel on funnel_email_sends (funnel_id);
create index if not exists idx_funnel_email_sends_lead on funnel_email_sends (lead_id);

-- 3) Suppression flag: a bounce/complaint unsubscribes the lead so 5b's nurture
-- engine skips them and any still-scheduled sends are canceled.
alter table funnel_leads add column if not exists email_unsubscribed boolean not null default false;

-- 4) Dedup opens to one funnel_events row per message (a client/proxy can fire
-- the open pixel many times). Clicks are deliberately NOT deduped — every click
-- is its own event. The webhook treats the 23505 from this index as a benign
-- duplicate.
create unique index if not exists uq_funnel_events_email_open
  on funnel_events (funnel_id, (metadata->>'resend_message_id'))
  where event_type = 'email_opened' and metadata->>'resend_message_id' is not null;
