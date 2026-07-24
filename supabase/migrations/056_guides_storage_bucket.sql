-- Storage bucket for The Guide's PDF, backing POST /api/guide/publish. Mirrors
-- the avatars / hub-covers public buckets: public read (the PDF must be directly
-- linkable without an auth header), and writes are NOT opened to anon/
-- authenticated roles — the backend only ever writes via the service role key,
-- which bypasses RLS, so no write policy is needed here.
insert into storage.buckets (id, name, public)
values ('guides', 'guides', true)
on conflict (id) do nothing;

drop policy if exists "Public read access for guides" on storage.objects;
create policy "Public read access for guides"
  on storage.objects for select
  using (bucket_id = 'guides');

-- The published Guide PDF's public URL for a (user_id, card_id) generation.
alter table mtm_generations add column if not exists guide_url text;
