-- Page cover thumbnails, backing POST /api/funnels/[id]/publish's cover
-- generation and the `page_covers` block on GET /api/funnels/[id]/analytics.
--
-- funnel_assets already exists live (created out-of-band, ahead of any
-- migration touching it) — this brings it under version control with the
-- schema already in production, rather than assuming a fresh create. One row
-- per (funnel_id, slot_key); a page cover's slot_key is 'cover_landing' /
-- 'cover_training' / 'cover_booking'. Re-publishing overwrites the existing
-- row via the unique index below, same upsert-in-place pattern as
-- funnel_launch_assets (migration 061).
create table if not exists funnel_assets (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id) on delete cascade,
  funnel_id uuid references funnels(id) on delete cascade,
  slot_key text not null,
  url text not null,
  file_size_bytes bigint
);

create unique index if not exists funnel_assets_funnel_id_slot_key_key
  on funnel_assets (funnel_id, slot_key);

comment on table funnel_assets is
  'Generated assets for a funnel, one row per (funnel_id, slot_key). Page covers use slot_key = cover_landing/cover_training/cover_booking.';

-- Public bucket for cover images — public read (rendered directly as <img src>
-- in the Pages tab, no auth header), writes only via the service role key
-- (which bypasses RLS), same pattern as guides/hub-covers/avatars.
insert into storage.buckets (id, name, public)
values ('funnel-covers', 'funnel-covers', true)
on conflict (id) do nothing;

drop policy if exists "Public read access for funnel-covers" on storage.objects;
create policy "Public read access for funnel-covers"
  on storage.objects for select
  using (bucket_id = 'funnel-covers');
