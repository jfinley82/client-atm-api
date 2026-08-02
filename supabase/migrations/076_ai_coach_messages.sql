-- Transcript store for the hosted lead-facing AI coach.
--
-- Written by the chat endpoint (a later PR); created here so the data layer
-- lands before anything depends on it. One row per turn, in order.
--
-- coach_user_id is denormalized alongside lead_id on purpose: every read is
-- "this coach's conversations" or "this lead's conversation", and carrying the
-- owner on the row means neither has to join through funnel_leads -> funnels to
-- establish ownership. It is also what keeps a transcript attributable after a
-- lead row is removed.
create table if not exists ai_coach_messages (
  id uuid primary key default gen_random_uuid(),
  -- Cascade: a deleted lead's transcript goes with them. The lead is the only
  -- subject of the conversation, so there is nothing left to keep.
  lead_id uuid not null references funnel_leads(id) on delete cascade,
  coach_user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- The only read shape the chat endpoint has: this lead's turns, oldest first.
create index if not exists idx_ai_coach_messages_lead on ai_coach_messages (lead_id, created_at);
-- Coach-level rollups (how many conversations, recent activity) without a join.
create index if not exists idx_ai_coach_messages_coach on ai_coach_messages (coach_user_id, created_at);

comment on table ai_coach_messages is
  'Turn-by-turn transcript of a lead''s conversation with a coach''s hosted AI coach. Written by the chat endpoint; role is user|assistant.';
