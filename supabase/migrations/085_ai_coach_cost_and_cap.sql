-- Cost attribution for prompt caching, and the conversation cap's counter.

-- Cached input is billed at different rates from ordinary input (a 1h cache
-- write is 2x base, a read is 0.1x), and `usage.input_tokens` EXCLUDES both. So
-- without these columns api_cost_log would show a cost drop with no way to
-- attribute it and no way to tell a cache hit from a miss — which is the number
-- the pricing decision waits on.
alter table api_cost_log add column if not exists cache_creation_input_tokens integer not null default 0;
alter table api_cost_log add column if not exists cache_read_input_tokens integer not null default 0;

comment on column api_cost_log.cache_creation_input_tokens is
  'Tokens written to the prompt cache on this call (billed above base input). 0 for uncached calls.';
comment on column api_cost_log.cache_read_input_tokens is
  'Tokens served from the prompt cache on this call (billed at a fraction of base input). 0 for uncached calls. Non-zero means a cache HIT.';

-- LIFETIME assistant-turn count for the hosted AI coach, per lead.
--
-- Deliberately NOT derived from count(ai_coach_messages): Restart deletes this
-- lead's rows, so a row-count cap would reset with it and a lead could restart
-- their way to unlimited turns. Restart has to keep honestly clearing the
-- thread, so the cap needs a counter Restart never touches. This is that
-- counter — incremented on every assistant turn, cleared by nothing.
alter table funnel_leads add column if not exists ai_coach_turns integer not null default 0;

comment on column funnel_leads.ai_coach_turns is
  'Lifetime count of hosted AI coach assistant turns for this lead. Never reset — Restart clears the transcript but not this, so the conversation cap cannot be bypassed by restarting.';
