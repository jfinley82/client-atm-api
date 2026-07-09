-- Append-only Anthropic API cost log. Deliberately NOT the saved_outputs
-- upsert-per-(user_id, tool_type) pattern — this needs to SUM across many
-- calls per period (every generation call, forever), not track one current
-- state. One row per Anthropic call.
CREATE TABLE api_cost_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  tool_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Supports the admin cost-dashboard's date-range queries (day/week/month).
CREATE INDEX IF NOT EXISTS idx_api_cost_log_created_at ON api_cost_log (created_at);
