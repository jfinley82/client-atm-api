-- Wins Board: members post wins and react (like) to each other's wins
CREATE TABLE wins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  win_type TEXT DEFAULT 'general'
    CHECK (win_type IN ('general', 'client', 'revenue',
    'milestone', 'booking')),
  likes_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE win_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  win_id UUID REFERENCES wins(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(win_id, user_id)
);

-- Supports the wins feed query (newest first) and per-win like lookups
CREATE INDEX IF NOT EXISTS idx_wins_created ON wins (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_win_likes_win ON win_likes (win_id);
