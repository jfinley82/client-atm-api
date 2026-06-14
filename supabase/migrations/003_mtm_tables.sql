-- Problem/Solution cards library
CREATE TABLE IF NOT EXISTS problem_solution_cards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_name TEXT NOT NULL,
  surface_problem TEXT,
  real_problem TEXT,
  urgency TEXT,
  tried_before JSONB DEFAULT '[]',
  your_solution TEXT,
  transformation TEXT,
  natural_bridge TEXT,
  hook_angle TEXT,
  training_title TEXT,
  validated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- MTM generated assets
CREATE TABLE IF NOT EXISTS mtm_generations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES problem_solution_cards(id) ON DELETE CASCADE,
  topics JSONB,
  chosen_topic TEXT,
  script TEXT,
  slides JSONB,
  emails JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_psc_user_id ON problem_solution_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_gen_user_id ON mtm_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_gen_card_id ON mtm_generations(card_id);
