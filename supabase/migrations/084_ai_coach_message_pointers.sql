-- Conversation pointer state for the hosted AI coach chat, on the transcript
-- rather than in a session table.
--
-- The conversation carries two pieces of pointer state: which of the coach's
-- problems it is currently about, and how far the brief has been revealed.
-- Serverless invocations share no memory, and a lead can come back three weeks
-- later on the same 30-day token. The last assistant row already survives both,
-- so it is where the pointers live — one extra read the chat was doing anyway,
-- no new table, no expiry to manage.
--
-- Both columns are written on ASSISTANT rows only and stay null on user rows.
--
-- on delete set null is deliberate: if the coach later deletes a blueprint, the
-- transcript keeps its text and loses its pointer, which is the honest outcome.
alter table ai_coach_messages add column if not exists resolved_card_id uuid references problem_solution_cards(id) on delete set null;
alter table ai_coach_messages add column if not exists reveal_stage text;

comment on column ai_coach_messages.resolved_card_id is
  'Assistant rows only: which of the coach''s problem cards the conversation was about as of this turn. Null on user rows; nulled if the card is deleted.';
comment on column ai_coach_messages.reveal_stage is
  'Assistant rows only: how far the brief panel had been revealed as of this turn (none|problem|transformation|full). Monotonic per lead; null on user rows.';
