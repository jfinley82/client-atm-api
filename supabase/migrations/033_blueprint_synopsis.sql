-- Per-blueprint scoring link + generated synopsis on problem_solution_cards.
-- Both nullable + additive — existing validated cards stay valid; a missing
-- synopsis is regenerated lazily at read time (see lib/blueprintEnrichment.ts).
--
--   source_problem_id : the matcher top_10 id (e.g. "p3") the card came from,
--                       so the card can be joined back to its match scoring
--                       (match_strength / match_factors) in matcher_analysis.
--                       finalize.ts did not previously persist this.
--   synopsis          : the generated per-blueprint synopsis (solution_summary,
--                       before/after, offer_includes, framework_fit).
alter table problem_solution_cards add column if not exists source_problem_id text;
alter table problem_solution_cards add column if not exists synopsis jsonb;
