-- Prompt-caching attribution on the API cost log.
--
-- Anthropic reports cache-attributed input in two buckets that sit OUTSIDE
-- input_tokens: cache_creation_input_tokens (tokens written to a new cache entry,
-- billed at 1.25x input for a 5m TTL / 2x for 1h) and cache_read_input_tokens
-- (tokens served from an existing entry, billed at 0.1x input). Without these
-- columns a cached call looks artificially cheap in the log — its input_tokens
-- collapse to just the uncached tail while the real spend moves into buckets we
-- weren't recording, which would make the caching rollout impossible to measure.
--
-- Defaulted to 0 and NOT NULL so historical rows (all pre-caching, hence
-- genuinely zero cache usage) stay correct and aggregate queries never have to
-- coalesce.
alter table api_cost_log
  add column if not exists cache_creation_input_tokens integer not null default 0,
  add column if not exists cache_read_input_tokens integer not null default 0;

comment on column api_cost_log.cache_creation_input_tokens is
  'Input tokens written to a prompt-cache entry on this call (billed at 1.25x input for 5m TTL, 2x for 1h). Separate from input_tokens.';
comment on column api_cost_log.cache_read_input_tokens is
  'Input tokens served from an existing prompt-cache entry on this call (billed at 0.1x input). Separate from input_tokens.';
