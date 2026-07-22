-- Funnel Builder — Settings consolidation. Account-level business settings that
-- are set once and reused across ALL of a coach's funnels: brand identity,
-- tracking pixels, meeting room, and legal/compliance. The public render sources
-- brand/tracking/legal from HERE (the funnel owner), not the per-funnel columns,
-- which become vestigial (kept for back-compat; no longer read).
--
-- Availability + calendar already have their own tables (043). Verified against
-- the live DB: funnel_business_settings does not exist.

create table if not exists funnel_business_settings (
  user_id uuid primary key references users(id) on delete cascade,
  business_name text,
  logo_url text,
  headshot_url text,             -- optional OVERRIDE; render falls back to users.avatar_url
  brand_primary_color text default '#020c31',
  brand_secondary_color text default '#6dd80e',
  theme_mode text default 'dark' check (theme_mode in ('dark', 'light')),
  brand_font text,
  tracking jsonb default '{}',   -- { google_tag_id, gtm_id, fb_pixel_id }
  zoom_link text,
  legal jsonb default '{}',      -- { privacy_url, terms_url, contact_url, disclaimer }
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Backfill (approved): seed each coach's business settings from their
-- MOST-RECENTLY-UPDATED funnel, so every live funnel keeps rendering once the
-- render reads account-level settings instead of the funnel row. distinct on
-- (user_id) + the order clause picks one funnel per coach; on conflict do nothing
-- makes this idempotent. business_name/legal are not per-funnel columns, so they
-- seed empty (render falls back to users.name for the business name).
insert into funnel_business_settings (
  user_id, logo_url, headshot_url, brand_primary_color, brand_secondary_color,
  theme_mode, brand_font, tracking, zoom_link
)
select distinct on (f.user_id)
  f.user_id,
  f.logo_url,
  f.headshot_url,
  coalesce(f.brand_primary_color, '#020c31'),
  coalesce(f.brand_secondary_color, '#6dd80e'),
  coalesce(f.theme_mode, 'dark'),
  f.brand_font,
  coalesce(f.tracking, '{}'::jsonb),
  f.zoom_link
from funnels f
where f.user_id is not null
order by f.user_id, f.updated_at desc nulls last, f.created_at desc nulls last
on conflict (user_id) do nothing;
