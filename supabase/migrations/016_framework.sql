-- Transformation Part B: Your Results Framework — the second deliverable of
-- Step 2 (Transform). One analyze → review → confirm flow that names the
-- member's delivery method and lays out its phases/steps. Stored under a new
-- saved_outputs tool_type, 'framework'. Additive only — every existing
-- tool_type and row is untouched.
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher', 'matcher_intake', 'matcher_analysis', 'transformation_analysis', 'framework'));
