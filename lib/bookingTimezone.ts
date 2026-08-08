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

/**
 * The UTC instant of a wall-clock time in a named zone — 09:00 on this date,
 * THERE.
 *
 * DST IS THE WHOLE REASON THIS IS NOT ARITHMETIC. A programme reminder at 09:00
 * America/Los_Angeles is 16:00Z in August and 17:00Z in November, and a stored
 * offset is a snapshot of one of those two answers. So the offset is resolved
 * AT THE INSTANT BEING SCHEDULED rather than at the moment of scheduling: a
 * reminder queued in August for a task due in December fires at 09:00 local,
 * not at 08:00.
 *
 * How it converges: read the date back out in the target zone, compare it to the
 * naive UTC parse, and subtract the difference. One pass is right except within
 * the hour a transition moves, where the correction itself changes the offset;
 * the second pass settles it. A third would be a no-op — it is there so a zone
 * with an unusual transition cannot leave the result an hour out silently.
 *
 * A null or unusable zone means UTC, deliberately and visibly: "we do not know
 * where they are" is a real state (client_timezone is nullable) and UTC is the
 * honest answer to it, not a guess dressed as one.
 */
export function zonedInstant(ymd: string, hour: number, minute: number, zone: string | null | undefined): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  const naive = Date.parse(`${ymd}T${hh}:${mm}:00Z`)
  if (!Number.isFinite(naive)) return null

  const tz = normalizeTimeZone(zone)
  if (!tz) return new Date(naive).toISOString()

  let ts = naive
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMs(ts, tz)
    if (offset === null) return new Date(naive).toISOString()
    const next = naive - offset
    if (next === ts) break
    ts = next
  }
  return new Date(ts).toISOString()
}

/**
 * How far ahead of UTC `zone` is at this instant, in milliseconds.
 *
 * Formatted parts rather than a library: Intl already knows every transition,
 * and a table of our own would be a copy that goes stale the next time a
 * government moves a clock.
 */
function zoneOffsetMs(ts: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ts))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    // Intl renders midnight as hour 24 in the hour12:false path on some engines.
    const hour = get('hour') % 24
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
    if (!Number.isFinite(asUtc)) return null
    return asUtc - ts
  } catch {
    return null
  }
}
