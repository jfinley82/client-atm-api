-- Membership tier on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_tier TEXT NOT NULL DEFAULT 'free';

-- Backfill existing paying users so they keep access through the tier gate
UPDATE users SET membership_tier = 'full' WHERE has_paid = true;

-- Purchases ledger
CREATE TABLE IF NOT EXISTS purchases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  stripe_payment_intent TEXT UNIQUE,
  amount_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);
