// How a booking time is rendered TO THE VISITOR.
//
// The problem this exists for: a stranger picked 6:30 PM with the page's zone
// selector reading America/Chicago, the on-screen confirmation agreed, and the
// email said "Tuesday, August 18, 2026 at 11:30 PM (UTC)". Same instant, useless
// rendering, and it is the first thing they see after handing over an address.
//
// UTC was never the bug — it was the honest fallback for a backend that was
// never told the visitor's zone. The request body carried no timezone at all;
// the selector was display-only. So the fix is upstream of any template: capture
// the zone, store it, and format with it.
//
// TWO AUDIENCES, TWO ZONES. Anything the VISITOR reads uses the zone they
// booked in — confirmation, reminders. Anything the COACH reads uses the coach's
// zone, which lib/email.ts already handles via coachTimeLabel and which this
// deliberately does not touch.

/**
 * Is this a real IANA zone name?
 *
 * Intl throws RangeError on an unknown zone, which is a complete check and needs
 * no zone list of our own to fall out of date.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

/** The stored form: a trimmed IANA name, or null when absent or unusable. */
export function normalizeTimeZone(tz: unknown): string | null {
  return isValidTimeZone(tz) ? (tz as string).trim() : null
}

/**
 * The visitor-facing label for a booking time.
 *
 * With a zone: "Tuesday, August 18, 2026 at 6:30 PM America/Chicago".
 * Without:     "Tuesday, August 18, 2026 at 11:30 PM (UTC)" — byte-identical to
 *              what shipped before, so a caller that sends no timezone sees no
 *              change at all.
 *
 * The zone NAME is rendered alongside the time rather than left implicit,
 * because a confirmation email gets forwarded and a bare "6:30 PM" is only
 * unambiguous to the person who picked it.
 */
export function bookingTimeLabel(startIso: string, timezone?: string | null): string {
  const zone = normalizeTimeZone(timezone)
  try {
    if (zone) {
      return (
        new Date(startIso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }) +
        ' ' +
        zone
      )
    }
    return (
      new Date(startIso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' (UTC)'
    )
  } catch {
    // A valid zone that Intl still refuses at format time, or an unparseable
    // date. Never let a label crash a booking that already succeeded.
    return startIso
  }
}
