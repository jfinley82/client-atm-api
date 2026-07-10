-- Storage bucket for member profile photos, backing POST /api/auth/upload-avatar.
-- Public read (the photo needs to be directly linkable/displayable without an
-- auth header). Writes are NOT opened up to anon/authenticated roles at all —
-- the backend only ever writes via the service role key (as it does for every
-- other Supabase access in this app), which bypasses RLS entirely, so no
-- write policy is needed or created here.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Public read access for avatars" on storage.objects;
create policy "Public read access for avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');
