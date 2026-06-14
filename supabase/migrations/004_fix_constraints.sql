-- Allow matcher as a valid tool_type in saved_outputs
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher'));

-- Remove monetization since it no longer exists as a tool
-- Note: if any existing rows have tool_type = 'monetization' this will fail.
-- Run this first to clean up any existing monetization rows:
DELETE FROM saved_outputs WHERE tool_type = 'monetization';
