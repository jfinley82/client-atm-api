-- Adds the UNIQUE constraint the Stripe webhook's upsert requires. The
-- webhook records a sale with .upsert(..., { onConflict: 'stripe_payment_intent' }),
-- but Supabase's onConflict needs a real UNIQUE constraint/index on that
-- column and the live table never had one — Postgres raised 42P10 ("no unique
-- or exclusion constraint matching the ON CONFLICT specification") and the
-- insert was rejected, so Accelerator sales granted access but were never
-- recorded in purchases (invisible to the revenue dashboard).
--
-- 005_membership_tiers.sql's CREATE TABLE declared stripe_payment_intent
-- TEXT UNIQUE, but the live schema drifted and lost it; this restores it.
-- Safe on existing data: no duplicate non-null values exist (verified before
-- applying), and Postgres treats NULLs as distinct, so the many NULL
-- stripe_payment_intent rows from the GHL/create-paid path remain valid.
-- Once present, the webhook upsert both records the row AND becomes
-- idempotent — a Stripe webhook retry for the same intent updates in place
-- instead of duplicating the sale.
ALTER TABLE purchases
  ADD CONSTRAINT purchases_stripe_payment_intent_key UNIQUE (stripe_payment_intent);
