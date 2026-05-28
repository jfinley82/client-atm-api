-- ============================================================
-- Client ATM Builder — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─── USERS ───────────────────────────────────────────────────
create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique not null,
  name                text,
  has_paid            boolean not null default false,
  stripe_customer_id  text unique,
  quiz_score          integer,
  quiz_completed      boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─── LEADS ───────────────────────────────────────────────────
create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  first_name  text,
  source      text not null default 'optin'
                check (source in ('optin','organic','paid_ad','referral','social_media','quiz','other')),
  created_at  timestamptz not null default now()
);

-- ─── MAGIC LINK TOKENS ───────────────────────────────────────
create table if not exists magic_link_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text unique not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_magic_link_tokens_token on magic_link_tokens(token);
create index if not exists idx_magic_link_tokens_user_id on magic_link_tokens(user_id);

-- ─── QUIZ RESPONSES ──────────────────────────────────────────
create table if not exists quiz_responses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique not null references users(id) on delete cascade,
  answers     jsonb not null default '{}',
  score       integer not null default 0,
  analysis    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_quiz_responses_user_id on quiz_responses(user_id);

-- ─── SAVED OUTPUTS ───────────────────────────────────────────
create table if not exists saved_outputs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  tool_type   text not null check (tool_type in ('audience','transformation','monetization')),
  content     jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, tool_type)
);

create index if not exists idx_saved_outputs_user_id on saved_outputs(user_id);

-- ─── AUTO-UPDATE TIMESTAMPS ──────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

create trigger quiz_responses_updated_at
  before update on quiz_responses
  for each row execute function update_updated_at();

create trigger saved_outputs_updated_at
  before update on saved_outputs
  for each row execute function update_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- We use service role key on the backend, so RLS is off.
-- If you ever want to expose Supabase directly to the frontend, enable these.

alter table users disable row level security;
alter table leads disable row level security;
alter table magic_link_tokens disable row level security;
alter table quiz_responses disable row level security;
alter table saved_outputs disable row level security;
