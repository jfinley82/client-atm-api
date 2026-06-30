-- Forum pinning: admins can pin posts to the top of the feed
ALTER TABLE forum_posts
ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT false;

ALTER TABLE forum_posts
ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
