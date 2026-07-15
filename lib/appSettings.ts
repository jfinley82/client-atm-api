// The complete set of app_settings keys anything in the platform actually
// consumes. Both write paths (PATCH /api/admin/settings and the legacy
// POST /api/settings) validate against this, so a stray form field can never
// silently upsert an orphan key that nothing reads — the write fails loudly
// with the offending key named instead. Confirmed during the 2026-07-15
// settings audit: these four are the only keys that exist in the table and
// the only ones the frontend uses; the admin form's other fields (office
// hours date/link, theme colors, sidebar unlock date) are dead — office
// hours live in the events table and sidebar unlocks in unlock_schedule.
// Add a key here (and seed/consume it) before letting any form write it.
export const ALLOWED_SETTING_KEYS = new Set([
  'training_video_url',
  'replay_video_url',
  'login_headline',
  'workshop_event_date',
])
