-- Voice Guide: a per-coach interview that captures how they actually talk, so
-- generated content/slides can sound like them instead of generic AI copy.
-- One row per user (unique on user_id). guide_md stays null until the
-- interview completes; qa_log accumulates {category, question, answer,
-- progress} entries as the interview progresses.
CREATE TABLE voice_guides (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'complete')),
  qa_log JSONB NOT NULL DEFAULT '[]',
  guide_md TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_guides_user_id ON voice_guides (user_id);
