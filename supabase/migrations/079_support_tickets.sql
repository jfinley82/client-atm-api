-- Support Desk: member ticket submission + admin triage.
--
-- text + CHECK rather than a Postgres enum type, matching how this repo already
-- models fixed value sets (funnel_leads.status, bookings.attended): widening a
-- CHECK is a DROP/re-ADD in a migration, where widening an enum type is a
-- separate ALTER TYPE that cannot run in the same transaction as its use.
--
-- SLA (first response 24h, resolution 72h) is deliberately NOT stored as a
-- deadline column. Both are derived at read time from created_at against
-- first_response_at/resolved_at — same discipline as deriving progress from raw
-- signals rather than a stored flag, so a target that changes later reprices
-- history correctly instead of leaving rows stamped against the old one.
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category text not null check (category in ('account_billing', 'technical', 'funnel_builder', 'crm_leads', 'other')),
  subject text not null,
  stage text not null default 'new' check (stage in ('new', 'in_progress', 'waiting_on_member', 'escalated', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  -- Optional context when the member reached the form from inside a funnel.
  -- set null on delete: a deleted funnel must not take its support history with
  -- it, unlike the ticket's own author.
  funnel_id uuid references funnels(id) on delete set null,
  assigned_admin_id uuid references users(id) on delete set null,
  first_response_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_support_tickets_user_id on support_tickets (user_id);
create index if not exists idx_support_tickets_stage on support_tickets (stage);
create index if not exists idx_support_tickets_created_at on support_tickets (created_at);

-- The whole conversation, member and admin turns alike. The member's original
-- description is the FIRST row here rather than a column on the ticket, so the
-- detail view renders one consistent thread instead of an "original message"
-- special case bolted on ahead of the replies.
create table if not exists support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author_user_id uuid not null references users(id) on delete cascade,
  author_role text not null check (author_role in ('member', 'admin')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_support_ticket_messages_ticket_id on support_ticket_messages (ticket_id);
