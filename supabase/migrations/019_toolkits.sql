-- Toolkits: 4 supplementary tools separate from the core Steps 1-3 pipeline —
-- High Ticket Offer Creator (program), Content Creator (content),
-- Micro-Training Slide Creator (slides), AI Lead Qualifier (qualifier). Each
-- is a one-shot analyze -> review -> confirm flow, stored under new
-- saved_outputs tool_type values. Additive only — every existing tool_type
-- and row is untouched.
ALTER TABLE saved_outputs DROP CONSTRAINT IF EXISTS saved_outputs_tool_type_check;
ALTER TABLE saved_outputs ADD CONSTRAINT saved_outputs_tool_type_check
  CHECK (tool_type IN ('audience', 'transformation', 'matcher', 'matcher_intake', 'matcher_analysis', 'transformation_analysis', 'framework', 'core_offers', 'program', 'content', 'slides', 'qualifier'));
