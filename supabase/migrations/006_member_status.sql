-- Account status (active/suspended) and beta-invite flag on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_as_beta BOOLEAN DEFAULT false;
