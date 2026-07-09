-- Record-only migration: this table was already created by hand directly in
-- Supabase (not through this repo's usual "paste in the SQL editor" flow) —
-- this file documents that reality for the migration history, it is NOT meant
-- to be (re-)applied.
create table if not exists assistant_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists assistant_messages_active_idx
  on assistant_messages (user_id, created_at)
  where archived_at is null;

alter table assistant_messages enable row level security;
