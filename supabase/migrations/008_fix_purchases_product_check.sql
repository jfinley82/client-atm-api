-- Allow the membership tiers the API actually writes ('low_ticket', 'full')
-- as valid purchases.product values. The existing purchases_product_check
-- constraint (added outside of migrations) rejected 'full', causing the
-- members/create-paid and stripe/webhook purchase inserts to fail with
-- error 23514 (check constraint violation).
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_product_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_product_check
  CHECK (product IN ('low_ticket', 'full'));
