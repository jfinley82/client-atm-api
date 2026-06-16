-- Additional generator outputs on mtm_generations
ALTER TABLE mtm_generations ADD COLUMN IF NOT EXISTS outline JSONB;
ALTER TABLE mtm_generations ADD COLUMN IF NOT EXISTS book_a_call_emails JSONB;
