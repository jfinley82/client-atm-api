-- Transformation tool gains a deep analysis layer (Step 2): 3 candidate
-- transformation framings the member picks from and confirms as the
-- foundation of their business identity. Additive only — the existing
-- 6-step before/after conversation and saved_outputs('transformation') are
-- completely untouched.
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher', 'matcher_intake', 'matcher_analysis', 'transformation_analysis'));
