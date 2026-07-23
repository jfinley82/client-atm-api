-- Public Training Hub (freeminiworkshop.com apex) — a curated, admin-managed
-- catalog of free mini-trainings. Each listing points at a coach's live funnel;
-- v1 is a launcher, no coach-facing changes. Verified live: no hub_listings
-- table existed.

create table if not exists hub_listings (
  id uuid primary key default gen_random_uuid(),
  funnel_id uuid not null references funnels(id) on delete cascade,
  title text not null,
  hook text,
  coach_name text not null,
  category text not null,
  cover_url text,
  featured boolean not null default false,
  sort_order integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Feed ordering index (published-first reads sort featured then sort_order).
create index if not exists idx_hub_listings_feed on hub_listings (status, featured, sort_order);
-- One listing per funnel.
create unique index if not exists uq_hub_listings_funnel on hub_listings (funnel_id);

-- Cover-image bucket. Public read (covers must be directly linkable); the
-- backend only ever writes via the service role, which bypasses RLS, so no
-- write policy is created — same as the avatars bucket (025).
insert into storage.buckets (id, name, public)
values ('hub-covers', 'hub-covers', true)
on conflict (id) do nothing;

drop policy if exists "Public read access for hub-covers" on storage.objects;
create policy "Public read access for hub-covers"
  on storage.objects for select
  using (bucket_id = 'hub-covers');
