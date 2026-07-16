-- Payment model: admit 'accelerator' ($1497, grants the full tier) as a valid
-- purchases.product value alongside low_ticket/full. Widening only — zero
-- behavior change for existing rows and flows. Without this, the first
-- Accelerator purchase insert fails with 23514 (check constraint violation),
-- the exact failure mode 008_fix_purchases_product_check.sql fixed for 'full'.
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_product_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_product_check
  CHECK (product IN ('low_ticket', 'full', 'accelerator'));
