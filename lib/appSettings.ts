import { parseWorkshopDate } from './workshopDate'

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
  // JSON array of booking-type labels ("Discovery Call", "Strategy Session")
  // offered as a dropdown on the public /book page. Read from the unauthenticated
  // GET, because that page has no session — which is also why the labels must be
  // publishable copy and nothing else. Normalized by normalizeBookingTypes in
  // lib/bookingQuestions.ts, which degrades a malformed value to no dropdown
  // rather than a broken form. Stored as a JSON STRING, matching booking_questions:
  // app_settings.value is text and both write paths reject a non-string value.
  'booking_types',
  // Community page branding. The dashboard reads these from the public GET with
  // the current copy as fallbacks, so they light up the moment values exist.
  'community_title',
  'community_description',
  'community_cover_url',
])

/**
 * Per-key validation and canonicalisation for a setting write.
 *
 * Both write paths run every value through here, so a key with a real format
 * cannot be given a meaningless one by whichever form posts it. Keys with no
 * entry pass through untouched — most settings are free text and should stay
 * that way; this is for the ones where a bad value is a silent breakage rather
 * than a visible typo.
 *
 * workshop_event_date earned its entry: it is an untyped text column nothing in
 * the backend parses, so it silently went from '2026-07-25T11:00-04:00' to
 * '2026-08-28' — a full instant replaced by a bare day, the time and offset
 * destroyed, and no signal anywhere. It now round-trips through a normalizer
 * that ACCEPTS both shapes (a day is a legitimate thing to mean) but rejects a
 * value that is neither, and pins an offset onto any time given without one.
 */
export function normalizeSettingValue(
  key: string,
  value: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (key === 'workshop_event_date') {
    const parsed = parseWorkshopDate(value)
    if (parsed === null) {
      return {
        ok: false,
        error:
          "value for 'workshop_event_date' must be a date (2026-08-28) or a date and time (2026-08-28T14:30, or 2026-08-28T14:30-04:00)",
      }
    }

    // WHAT IS SENT IS WHAT IS STORED. A date with no time clears any time that
    // was there, because a date with no time is now a thing the admin can
    // deliberately mean.
    //
    // This briefly did the opposite: it carried a stored time onto a date-only
    // post, on the reasoning that <input type="date"> cannot express a time and
    // so cannot be asking to remove one. That reasoning depended on the control,
    // and the control changed — the form now has date, time and zone inputs, and
    // posts date-only to mean exactly that. The rule then made "a day, no
    // particular time" unreachable: the only escape was an empty string, which
    // clears the date too.
    //
    // The general lesson, worth more than the rule: do not infer intent from the
    // SHAPE of a value. Shape is a property of whatever control happened to
    // produce it, so an inference drawn from it expires silently when that
    // control is replaced. If a net for older callers is ever wanted, gate it on
    // an explicit signal in the request. carryTimeOnto survives in
    // lib/workshopDate.ts for that, and is deliberately not wired here.
    return { ok: true, value: parsed.value }
  }
  return { ok: true, value }
}
