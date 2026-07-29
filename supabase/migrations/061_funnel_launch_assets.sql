-- Growth Kit: per-funnel launch assets.
--
-- Each row is ONE generated asset for ONE funnel. Assets are produced on demand
-- (one asset_type at a time), not as a batch, so a coach can pull just the piece
-- they need and regenerate it independently of the others.
--
-- The six types split into three groups:
--   invite_emails    — NOT newly written copy. Surfaces the coach's existing
--                      warm-invite emails from mtm_generations with the funnel
--                      link substituted in, so the invite they already approved
--                      is what goes out.
--   social_5day      — net-new generated copy (a 5-day social run-up).
--   call_flow, sales_script, objection_scripts, post_call_emails
--                    — the "win the call" four, all grounded on the house sales
--                      methodology (lib/salesFrameworksCanonical.ts). These are
--                      gated in the API on the funnel having at least one
--                      booking: they are useless before there's a call to win,
--                      and generating them early burns tokens on a coach who
--                      cannot act on them yet.
--
-- One row per (funnel_id, asset_type) — regeneration overwrites in place via the
-- unique index below rather than accumulating history. If versioning is ever
-- wanted, drop the unique index and add a `version` column; nothing here depends
-- on there being exactly one row beyond the upsert conflict target.
create table if not exists funnel_launch_assets (
  id uuid default gen_random_uuid() primary key,
  funnel_id uuid not null references funnels(id) on delete cascade,
  asset_type text not null check (
    asset_type in (
      'invite_emails',
      'social_5day',
      'call_flow',
      'sales_script',
      'objection_scripts',
      'post_call_emails'
    )
  ),
  content jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

-- Upsert target for regeneration, and the lookup the read path uses.
create unique index if not exists funnel_launch_assets_funnel_type_key
  on funnel_launch_assets (funnel_id, asset_type);

-- The Growth Kit tab lists every asset for one funnel in one query.
create index if not exists funnel_launch_assets_funnel_idx
  on funnel_launch_assets (funnel_id);

comment on table funnel_launch_assets is
  'Growth Kit assets generated per funnel, one row per (funnel_id, asset_type). Regeneration upserts in place.';
comment on column funnel_launch_assets.content is
  'Asset payload; shape varies by asset_type (see lib/funnelLaunchAssets.ts for the per-type contract).';
