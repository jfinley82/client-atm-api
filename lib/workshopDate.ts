// The workshop date/time, and the one place that decides what a valid one looks
// like.
//
// WHY THIS EXISTS. app_settings.value is an untyped text column and nothing in
// the backend parses workshop_event_date, so for as long as it has existed any
// string at all could be stored under it. That is how it silently went from
// '2026-07-25T11:00-04:00' to '2026-08-28' — a date-only value overwrote a full
// instant, the time and the offset were destroyed, and nothing anywhere noticed
// because nothing anywhere was looking.
//
// THE CANONICAL FORM is ISO 8601 with an explicit offset, plus an optional
// bracketed IANA zone (RFC 9557 / IXDTF, the suffix Temporal emits):
//
//     2026-08-28T14:30-04:00
//     2026-08-28T14:30-05:00[America/Chicago]
//
// The offset pins the instant; the zone name is what lets a renderer say
// "Central" and follow the zone across a DST boundary, which an offset alone
// cannot do. Both round-trip, so an admin zone picker has somewhere to put its
// value.
//
// An offset rather than a bare local time because a workshop happens at ONE
// instant and is read by people in several timezones; a naive '14:30' is only
// unambiguous to whoever typed it. An offset rather than UTC because the stored
// value stays legible to the admin who set it.
//
// A DATE WITHOUT A TIME IS STILL VALID — '2026-08-28' means the day, with no
// claim about when. That keeps the existing admin form working unchanged while
// the frontend grows a time input, and it is a real thing an admin might mean.
// hasTime on the parsed result is how a consumer tells the two apart, so a
// day-only value can render as a date instead of inventing midnight.

// The zone a wall-clock time is interpreted in when the admin supplies a time
// with no offset — which is what <input type="datetime-local"> produces.
//
// Hardcoded rather than configurable because there is exactly one workshop
// calendar and it runs on Eastern; the previous stored value was -04:00, i.e.
// this zone in summer. DST is resolved per-instant below rather than assumed, so
// a January workshop correctly gets -05:00 and an August one -04:00.
export const WORKSHOP_TIME_ZONE = 'America/New_York'

export type WorkshopDate = {
  /** The canonical stored string. */
  value: string
  /** Whether a time of day was supplied, or only a calendar date. */
  hasTime: boolean
  /** The instant, when a time is present. Null for a date-only value. */
  instant: Date | null
  /** The IANA zone the admin chose, when they named one. */
  timeZone: string | null
}

// A NAMED ZONE may be appended in brackets: ...T14:30[America/Chicago].
// That is RFC 9557 / IXDTF, the same suffix Temporal emits — a real standard
// rather than a shape invented here, so a zone picker on the admin form has
// something to send that survives a round trip. It is what an offset alone
// cannot carry: -05:00 pins the instant but cannot say "Central", so a renderer
// has no zone name to show and no way to follow the zone across a DST boundary.
const ZONE_SUFFIX = /\[([A-Za-z0-9_+\-\/]+)\]$/

// Date only: 2026-08-28
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
// Date + time, offset optional: 2026-08-28T14:30[:05][Z|±HH:MM|±HHMM]
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i

/** The UTC offset, in minutes, that `timeZone` is at the given instant. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00'
  const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * Resolve a naive wall-clock time in WORKSHOP_TIME_ZONE to a real instant.
 *
 * Two passes, because the offset depends on the instant and the instant depends
 * on the offset. The first pass guesses using the naive time read as UTC, the
 * second corrects it — which matters only within an hour of a DST boundary, but
 * that is exactly the case nobody tests and everybody hits eventually.
 */
function resolveWallClock(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string) {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  let offset = zoneOffsetMinutes(new Date(naiveUtc), timeZone)
  let instant = new Date(naiveUtc - offset * 60_000)
  offset = zoneOffsetMinutes(instant, timeZone)
  instant = new Date(naiveUtc - offset * 60_000)
  return { instant, offset }
}

function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const zoneTag = (tz: string | null): string => (tz ? `[${tz}]` : '')

function isRealDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, mo - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

/**
 * Parse a workshop date into its canonical form, tolerantly.
 *
 * Accepts, in order of how likely the admin form is to send it:
 *   '2026-08-28'                  a day, no time            -> unchanged
 *   '2026-08-28T14:30'            datetime-local input      -> offset added
 *   '2026-08-28T14:30:00'         with seconds              -> offset added
 *   '2026-08-28T14:30-04:00'      already canonical         -> kept
 *   '2026-08-28T18:30Z'           UTC                       -> converted
 *   '2026-08-28T14:30[America/Chicago]'  zone picker         -> offset resolved
 *                                                               IN that zone,
 *                                                               zone preserved
 *   ''                            cleared                   -> empty, valid
 *
 * Returns null for anything it cannot make sense of, including an impossible
 * calendar date like 2026-02-30. Never throws.
 */
export function parseWorkshopDate(raw: unknown): WorkshopDate | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return { value: '', hasTime: false, instant: null, timeZone: null }

  // Peel off a bracketed zone before anything else, so the rest of the parsing
  // is unchanged whether or not one is present.
  let namedZone: string | null = null
  const zoneMatch = ZONE_SUFFIX.exec(s)
  if (zoneMatch) {
    if (!isKnownZone(zoneMatch[1])) return null
    namedZone = zoneMatch[1]
    s = s.slice(0, zoneMatch.index).trim()
  }

  const dateOnly = DATE_ONLY.exec(s)
  if (dateOnly) {
    const [, y, mo, d] = dateOnly
    if (!isRealDate(Number(y), Number(mo), Number(d))) return null
    // A day carries no instant, so a zone on it says nothing — drop it rather
    // than store a claim the value cannot support.
    return { value: `${y}-${mo}-${d}`, hasTime: false, instant: null, timeZone: null }
  }

  const full = DATE_TIME.exec(s)
  if (!full) return null
  const [, ys, mos, ds, hs, mis, ss, zone] = full
  const y = Number(ys)
  const mo = Number(mos)
  const d = Number(ds)
  const h = Number(hs)
  const mi = Number(mis)
  const sec = Number(ss || 0)
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null

  const stamp = `${ys}-${mos}-${ds}T${hs}:${mis}`

  if (!zone) {
    // Naive wall clock — interpret it in the NAMED zone when the admin chose one,
    // otherwise the workshop's default zone, and pin the resulting offset so the
    // stored value can never be re-read as a different instant.
    const { instant, offset } = resolveWallClock(y, mo, d, h, mi, sec, namedZone || WORKSHOP_TIME_ZONE)
    return { value: `${stamp}${formatOffset(offset)}${zoneTag(namedZone)}`, hasTime: true, instant, timeZone: namedZone }
  }

  if (/^z$/i.test(zone)) {
    const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, sec))
    return { value: `${stamp}+00:00${zoneTag(namedZone)}`, hasTime: true, instant, timeZone: namedZone }
  }

  // Explicit offset: trust it, normalize its punctuation.
  const om = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (!om) return null
  const offsetMinutes = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]))
  const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, sec) - offsetMinutes * 60_000)
  return {
    value: `${stamp}${formatOffset(offsetMinutes)}${zoneTag(namedZone)}`,
    hasTime: true,
    instant,
    timeZone: namedZone,
  }
}

/** The canonical string to store, or null if the input is not a workshop date. */
export function normalizeWorkshopDate(raw: unknown): string | null {
  return parseWorkshopDate(raw)?.value ?? null
}

/**
 * Move a stored time onto a new date.
 *
 * NOT WIRED TO ANY WRITE PATH, deliberately. Do not reconnect it to one on the
 * basis of the incoming value's shape.
 *
 * It briefly ran in normalizeSettingValue, carrying a stored time onto a
 * date-only post. The argument was that `<input type="date">` cannot express a
 * time, so such a post could not mean "clear the time" — and the note claimed
 * the rule was self-limiting, since a form that sent datetimes would never
 * trigger it. Both statements were about a CONTROL, not about the data. The form
 * gained date, time and zone inputs and began posting date-only to mean exactly
 * that, at which point the rule made "a day, no particular time" unreachable:
 * the only way out was an empty string, which clears the date as well.
 *
 * The lesson is the reusable part. Intent inferred from the shape of a value is
 * really an inference about whatever produced it, and it expires in silence when
 * that thing is replaced. A net for legacy callers belongs behind an explicit
 * signal in the request, where it can be seen and removed.
 *
 * What remains here is the arithmetic, which is correct and worth keeping for a
 * caller that has decided, on its own evidence, that a time should move.
 *
 * DST is re-resolved rather than copied. If the stored offset was the workshop
 * zone's own offset on its own date, the value is an Eastern wall-clock time and
 * the new date gets the offset that applies THEN — moving an 11:00 -04:00 August
 * workshop to January yields 11:00 -05:00, still 11am to everyone involved,
 * rather than 10am. If the offset was something else the admin pinned another
 * zone deliberately, so it is preserved literally.
 */
export function carryTimeOnto(dateOnly: string, currentValue: unknown): string | null {
  const cur = parseWorkshopDate(currentValue)
  if (!cur || !cur.hasTime || !cur.instant) return null

  const m = /T(\d{2}):(\d{2})([+-]\d{2}:\d{2})/.exec(cur.value)
  if (!m) return null
  const [, hh, mi, off] = m

  // A NAMED zone is the strongest signal: re-resolve the same wall-clock time in
  // that zone on the new date, so the workshop stays at 11am to the people it
  // was scheduled for even if the move crosses a DST boundary.
  if (cur.timeZone) return normalizeWorkshopDate(`${dateOnly}T${hh}:${mi}[${cur.timeZone}]`)

  // No named zone. If the stored offset was the default zone's own offset on its
  // own date, treat it as a wall-clock time there and re-resolve; otherwise the
  // admin pinned an offset deliberately and it is preserved literally.
  const wasZoneLocal = formatOffset(zoneOffsetMinutes(cur.instant, WORKSHOP_TIME_ZONE)) === off
  return normalizeWorkshopDate(wasZoneLocal ? `${dateOnly}T${hh}:${mi}` : `${dateOnly}T${hh}:${mi}${off}`)
}
