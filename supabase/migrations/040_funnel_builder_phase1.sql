-- MTM Funnel Builder — Phase 1 delta.
-- Extends the Phase 0 `funnels` table (migration 012) in place and adds the two
-- capture tables. Nothing here recreates `funnels` — all funnel changes are
-- ALTER ... ADD COLUMN IF NOT EXISTS so this is safe to re-run.

-- Page copy + brand-kit + tracking config the builder saves and the public
-- renderer reads. landing_page is generated at creation; the other two pages
-- are edited in the studio.
alter table funnels add column if not exists landing_page jsonb;
alter table funnels add column if not exists training_page jsonb;
alter table funnels add column if not exists booking_page jsonb;
alter table funnels add column if not exists logo_url text;
alter table funnels add column if not exists headshot_url text;
alter table funnels add column if not exists brand_font text;
alter table funnels add column if not exists video_url text;
alter table funnels add column if not exists tracking jsonb default '{}';
alter table funnels add column if not exists watch_threshold_pct int default 50;
alter table funnels add column if not exists published_at timestamptz;

-- Leads captured by a live funnel's opt-in form. userId ownership is via the
-- parent funnel (funnels.user_id); no RLS — every read/write goes through the
-- authenticated API which scopes by owner, and public writes only INSERT.
create table if not exists funnel_leads (
  id uuid default gen_random_uuid() primary key,
  funnel_id uuid not null references funnels(id) on delete cascade,
  first_name text,
  email text not null,
  phone text,
  opted_in_at timestamptz default now(),
  -- Frozen copy of the funnel's problem/solution tagging at opt-in time, so a
  -- lead keeps its context even if the funnel is later re-pointed or edited.
  problem_solution_snapshot jsonb,
  status text not null default 'lead' check (status in ('lead', 'booked', 'closed')),
  close_amount numeric,
  notes text,
  source text,
  ip text,
  created_at timestamptz default now()
);

create index if not exists idx_funnel_leads_funnel_id on funnel_leads (funnel_id);
create index if not exists idx_funnel_leads_email on funnel_leads (email);

-- Funnel-page analytics events. lead_id is null for pre-opt-in page views.
create table if not exists funnel_events (
  id uuid default gen_random_uuid() primary key,
  funnel_id uuid not null references funnels(id) on delete cascade,
  lead_id uuid references funnel_leads(id) on delete set null,
  event_type text not null
    check (event_type in ('landing_view', 'training_view', 'signup', 'booking_click', 'booked')),
  created_at timestamptz default now()
);

create index if not exists idx_funnel_events_funnel_id on funnel_events (funnel_id);
create index if not exists idx_funnel_events_type on funnel_events (event_type);
