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
// THE CANONICAL FORM is ISO 8601 with an explicit offset:
//
//     2026-08-28T14:30-04:00
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
}

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
function resolveWallClock(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  let offset = zoneOffsetMinutes(new Date(naiveUtc), WORKSHOP_TIME_ZONE)
  let instant = new Date(naiveUtc - offset * 60_000)
  offset = zoneOffsetMinutes(instant, WORKSHOP_TIME_ZONE)
  instant = new Date(naiveUtc - offset * 60_000)
  return { instant, offset }
}

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
 *   ''                            cleared                   -> empty, valid
 *
 * Returns null for anything it cannot make sense of, including an impossible
 * calendar date like 2026-02-30. Never throws.
 */
export function parseWorkshopDate(raw: unknown): WorkshopDate | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return { value: '', hasTime: false, instant: null }

  const dateOnly = DATE_ONLY.exec(s)
  if (dateOnly) {
    const [, y, mo, d] = dateOnly
    if (!isRealDate(Number(y), Number(mo), Number(d))) return null
    return { value: `${y}-${mo}-${d}`, hasTime: false, instant: null }
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
    // Naive wall clock — interpret it in the workshop's zone and pin the offset,
    // so the stored value can never be re-read as a different instant.
    const { instant, offset } = resolveWallClock(y, mo, d, h, mi, sec)
    return { value: `${stamp}${formatOffset(offset)}`, hasTime: true, instant }
  }

  if (/^z$/i.test(zone)) {
    const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, sec))
    return { value: `${stamp}+00:00`, hasTime: true, instant }
  }

  // Explicit offset: trust it, normalize its punctuation.
  const om = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (!om) return null
  const offsetMinutes = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]))
  const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, sec) - offsetMinutes * 60_000)
  return { value: `${stamp}${formatOffset(offsetMinutes)}`, hasTime: true, instant }
}

/** The canonical string to store, or null if the input is not a workshop date. */
export function normalizeWorkshopDate(raw: unknown): string | null {
  return parseWorkshopDate(raw)?.value ?? null
}
