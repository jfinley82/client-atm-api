-- Step 3 capstone: Core Offers. Runs after all 3 Blueprints (problem_solution_
-- cards) are finalized, plus a confirmed Audience Profile, Transformation, and
-- Framework — generates a low-ticket and a high-ticket offer from that combined
-- context. One analyze -> review -> confirm flow, stored under a new
-- saved_outputs tool_type, 'core_offers'. Additive only — every existing
-- tool_type and row is untouched.
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher', 'matcher_intake', 'matcher_analysis', 'transformation_analysis', 'framework', 'core_offers'));
