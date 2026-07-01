-- MTM Funnel Builder — Phase 0 foundation
-- Add-on entitlement on users; set { "funnel_builder": true } on purchase.
ALTER TABLE users ADD COLUMN IF NOT EXISTS add_ons JSONB DEFAULT '{}';

-- Funnels owned by members with the funnel_builder add-on
CREATE TABLE funnels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES mtm_generations(id),
  subdomain TEXT UNIQUE,
  template_id TEXT DEFAULT 'template_1',

  -- Branding
  brand_primary_color TEXT DEFAULT '#020c31',
  brand_secondary_color TEXT DEFAULT '#6dd80e',
  theme_mode TEXT DEFAULT 'dark'
    CHECK (theme_mode IN ('dark', 'light')),

  -- Problem/solution tagging (frozen at creation, inherited by every lead who opts in)
  problem_solution_label TEXT,
  problem_solution_snapshot JSONB,

  -- Opt-in form config
  collect_name BOOLEAN DEFAULT FALSE,
  collect_phone BOOLEAN DEFAULT FALSE,

  -- Calendar (used starting Phase 4, but scaffolded now)
  calendar_mode TEXT DEFAULT 'native'
    CHECK (calendar_mode IN ('native', 'calendly', 'google', 'external')),
  external_calendar_url TEXT,

  -- Application questions (used starting Phase 4, but scaffolded now)
  application_questions_enabled BOOLEAN DEFAULT FALSE,
  disqualify_action TEXT DEFAULT 'flag'
    CHECK (disqualify_action IN ('block', 'flag')),
  disqualify_message TEXT DEFAULT 'Thanks for your interest — this isn''t the right fit right now.',

  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'live')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnels_user_id ON funnels (user_id);
CREATE INDEX IF NOT EXISTS idx_funnels_subdomain ON funnels (subdomain);
