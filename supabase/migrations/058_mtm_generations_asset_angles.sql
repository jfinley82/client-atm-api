-- Per-asset angle stamp: which chosen_angle each downstream asset was generated
-- on, so the app can SHOW which assets are out of sync with the currently
-- selected angle. { <asset key>: <chosen_angle text> }. Purely a state layer —
-- generation behavior is unchanged. Existing rows default empty (an unstamped
-- asset reads as in-sync).
alter table mtm_generations add column if not exists asset_angles jsonb not null default '{}'::jsonb;
