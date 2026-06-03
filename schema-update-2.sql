-- ============================================================
-- Client ATM Builder — Schema Update 2
-- Adds: profile fields, user_settings, chat_messages
-- Run this in: Supabase Dashboard > SQL Editor (idempotent)
-- ============================================================

-- ─── PROFILE FIELDS ──────────────────────────────────────────
-- Used by api/auth/update-profile.ts
alter table users add column if not exists business_name text;
alter table users add column if not exists bio text;
alter table users add column if not exists avatar_url text;

-- ─── USER SETTINGS ───────────────────────────────────────────
-- Used by api/settings/index.ts (one row per user)
create table if not exists user_settings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid unique not null references users(id) on delete cascade,
  email_notifications boolean not null default true,
  product_updates     boolean not null default true,
  theme               text not null default 'system'
                        check (theme in ('light','dark','system')),
  preferences         jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_user_settings_user_id on user_settings(user_id);

-- ─── CHAT MESSAGES ───────────────────────────────────────────
-- Used by api/tools/chat.ts (coaching assistant history)
create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_chat_messages_user_id on chat_messages(user_id);
create index if not exists idx_chat_messages_user_created on chat_messages(user_id, created_at);

-- ─── AUTO-UPDATE TIMESTAMPS ──────────────────────────────────
-- update_updated_at() is defined in schema.sql
drop trigger if exists user_settings_updated_at on user_settings;
create trigger user_settings_updated_at
  before update on user_settings
  for each row execute function update_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- Backend uses the service role key, so RLS stays off (matches existing tables).
alter table user_settings disable row level security;
alter table chat_messages disable row level security;
