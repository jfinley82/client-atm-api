-- Nullable snapshot of the upstream (audience/transformation/matcher_intake)
-- updated_at values as of the moment a Blueprint batch was finalized — used
-- by the sync/staleness system (lib/syncDependencies.ts) to detect when a
-- validated card was built from data that has since changed. NULL for cards
-- finalized before this feature existed; those are simply skipped by the
-- staleness check rather than treated as stale or in-sync.
ALTER TABLE problem_solution_cards ADD COLUMN IF NOT EXISTS sync_snapshot JSONB;
