// The set of app_settings keys the write paths accept. Both write paths
// (PATCH /api/admin/settings and the legacy POST /api/settings) validate
// against this, so a stray form field can never silently upsert an orphan
// key that nothing reads — the write fails loudly with the offending key
// named instead. Add a key here (and seed/consume it) before letting any
// form write it.
//
// EVERY KEY HERE IS PUBLIC. Only admins can write, but GET /api/settings is
// unauthenticated and returns every stored row unfiltered — so admitting a key
// to this allowlist is publishing whatever gets written to it, to anyone, no
// login required. Fine for community branding and workshop copy; NOT fine for
// a key holding anything internal, per-member, or secret. If a future setting
// must not be world-readable, it does not belong in this table at all — gate
// it behind its own authenticated read, don't add it here and hope.
//
// The first four are the fully-functional settings (stored, returned, and
// consumed by the frontend). The last four are current keys kept per the
// 2026-07-15 settings audit even though no backend code consumes them yet —
// the admin form still writes them, so rejecting them would break its Save
// until the form cleanup ships. Office hours date/link are deliberately NOT
// here: office hours live in the events table now, and sidebar unlocks have
// their own unlock_schedule table (sidebar_unlock_date below is the legacy
// settings key, retained while the form still sends it).
export const ALLOWED_SETTING_KEYS = new Set([
  'training_video_url',
  'replay_video_url',
  'login_headline',
  'workshop_event_date',
  'primary_color',
  'secondary_color',
  'button_color',
  'sidebar_unlock_date',
  'book_a_call_url',
  // JSON array of admin-defined booking-form questions (see lib/bookingQuestions.ts).
  'booking_questions',
  // Community page branding. The dashboard reads these from the public GET with
  // the current copy as fallbacks, so they light up the moment values exist.
  'community_title',
  'community_description',
  'community_cover_url',
])
