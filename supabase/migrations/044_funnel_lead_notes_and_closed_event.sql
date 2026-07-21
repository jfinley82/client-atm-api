-- Funnel Builder Phase 2.5 — notes thread + 'closed' engagement event.
-- Verified against the live DB: funnel_lead_notes does not exist, and the
-- funnel_events CHECK is landing_view/training_view/signup/booking_click/booked
-- (no 'closed').

-- Add 'closed' so a lead moving to closed can be logged as an engagement event
-- on its timeline. DROP + re-ADD, mirroring the constraint-swap pattern in 042.
-- (Video/email engagement types — video_watched/completed, email_opened/clicked
-- — are added by Phases 4 and 5, not here.)
alter table funnel_events drop constraint if exists funnel_events_event_type_check;
alter table funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'landing_view', 'training_view', 'signup', 'booking_click', 'booked', 'closed'
  ]));

-- Timestamped, author-attributed notes thread per lead (the Phase 2.5 primary;
-- the legacy funnel_leads.notes single field stays for back-compat). Owner scope
-- is via the parent funnel (funnels.user_id); no RLS — every read/write goes
-- through the authenticated, owner-checked API.
create table if not exists funnel_lead_notes (
  id uuid default gen_random_uuid() primary key,
  funnel_id uuid not null references funnels(id) on delete cascade,
  lead_id uuid not null references funnel_leads(id) on delete cascade,
  author_user_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz default now()
);

create index if not exists idx_funnel_lead_notes_lead on funnel_lead_notes (lead_id, created_at desc);
create index if not exists idx_funnel_lead_notes_funnel on funnel_lead_notes (funnel_id);
