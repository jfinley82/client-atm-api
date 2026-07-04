-- Matcher tool redesign: richer per-card content than the original
-- surface_problem/real_problem/your_solution split supported. Additive only —
-- old columns stay, unused by new rows; nothing existing reads these three by
-- name, so no backfill is needed.
ALTER TABLE problem_solution_cards
  ADD COLUMN IF NOT EXISTS problem_text TEXT,
  ADD COLUMN IF NOT EXISTS reasoning TEXT,
  ADD COLUMN IF NOT EXISTS suggested_offer JSONB;

-- The new matcher flow splits what used to be one 'matcher' saved_outputs row
-- into two: the short existing-offer intake, and the generated top-10
-- analysis. 'matcher' itself is kept in the allowed set (not dropped) so
-- historical rows from the old 6-step flow remain valid — nothing new writes
-- to it going forward, but nothing should break reading it either.
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher', 'matcher_intake', 'matcher_analysis'));
