-- One level of undo for the scoped angle rebuild. Before a rebuild re-syncs the
-- target assets to the current angle, it stores a copy of the pre-rebuild asset
-- columns (+ asset_angles / chosen_topic / chosen_angle / angle_source) here so a
-- restore can put them back. Nullable; a restore clears it back to null. Purely a
-- state layer for the rebuild/restore actions.
alter table mtm_generations add column if not exists pre_rebuild_snapshot jsonb default null;
