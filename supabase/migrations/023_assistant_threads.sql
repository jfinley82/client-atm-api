-- Record-only migration: assistant_threads and assistant_messages.thread_id
-- were already created by hand directly in Supabase — this file documents
-- that reality for the migration history, it is NOT meant to be (re-)applied.
create table if not exists assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists assistant_threads_active_idx
  on assistant_threads (user_id, started_at)
  where ended_at is null;

create index if not exists assistant_threads_user_idx
  on assistant_threads (user_id, started_at desc);

alter table assistant_messages
  add column if not exists thread_id uuid references assistant_threads(id) on delete cascade;

create index if not exists assistant_messages_thread_idx
  on assistant_messages (thread_id, created_at);
