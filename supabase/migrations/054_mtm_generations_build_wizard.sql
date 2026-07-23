-- Build wizard (Angle → Slides → Emails → Script → Objections → Finish). Adds
-- the two net-new generated assets, the lightweight angle previews, and the
-- per-step approval state to the canonical mtm_generations row. All jsonb,
-- additive; existing rows default empty.
alter table mtm_generations add column if not exists sales_script jsonb default '[]'::jsonb;   -- 6-beat call script
alter table mtm_generations add column if not exists objections jsonb default '[]'::jsonb;      -- objection set (voiced + loop-mapped)
alter table mtm_generations add column if not exists angle_previews jsonb default '[]'::jsonb;   -- light per-angle previews
alter table mtm_generations add column if not exists build_steps jsonb default '{}'::jsonb;      -- { step: { approved, approved_at } }
