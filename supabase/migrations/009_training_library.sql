-- Training Library: admin-managed training videos shown to members
CREATE TABLE training_videos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_minutes INTEGER,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  is_published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Supports the member-facing query: published videos ordered by published_at DESC
CREATE INDEX IF NOT EXISTS idx_training_videos_published
  ON training_videos (is_published, published_at DESC);
