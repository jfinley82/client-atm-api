-- Slides consolidation (Task 5): the slides toolkit's staleness gate used to
-- live in saved_outputs[slides].by_card_id[cardId].sync_snapshot. Now that
-- slides are consolidated onto the canonical mtm_generations row, its staleness
-- snapshot moves here too — one home, no by_card_id sidecar.
--
-- sync_snapshot holds the 'slides' dependency timestamps (audience / framework /
-- card) as of the last time the row's slides were generated or regenerated. See
-- lib/syncDependencies.ts (SYNC_DEPENDENCIES.slides) + computeStaleness.
alter table mtm_generations add column if not exists sync_snapshot jsonb;
