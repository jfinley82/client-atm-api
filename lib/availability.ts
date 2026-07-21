// Pure slot-computation engine for the funnel booking calendar. No I/O — the
// endpoints load settings + busy intervals and call these. Kept pure so the
// timezone / DST / overlap math is unit-testable headlessly.

export type Slot = { start: string; end: string } // both UTC ISO
export type Interval = { start: string; end: string } // busy intervals, UTC ISO
export type DayWindow = { start: string; end: string } | null // "HH:MM" wall-clock, or null (day off)

export type WorkingHours = {
  timezone: string
  mon?: DayWindow
  tue?: DayWindow
  wed?: DayWindow
  thu?: DayWindow
  fri?: DayWindow
  sat?: DayWindow
  sun?: DayWindow
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timezone: 'UTC',
  mon: { start: '09:00', end: '17:00' },
  tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' },
  thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' },
  sat: null,
  sun: null,
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

// Offset (ms) between wall-clock time in `tz` and UTC, at the given instant:
// (that instant read as a tz wall clock, interpreted as if UTC) minus the instant.
// Positive east of UTC. DST-correct because it's evaluated at the instant.
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  )
  return asUtc - date.getTime()
}

// The UTC instant for a wall-clock Y-M-D H:M in timezone `tz`. Refines once so a
// time that lands on a DST transition resolves to the correct offset.
function zonedWallToUtc(y: number, mo1: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo1, d, h, mi)
  const off1 = tzOffsetMs(new Date(guess), tz)
  let instant = guess - off1
  const off2 = tzOffsetMs(new Date(instant), tz)
  if (off2 !== off1) instant = guess - off2
  return new Date(instant)
}

// The Y-M-D calendar date (in `tz`) that a UTC instant falls on.
function localYmd(date: Date, tz: string): { y: number; mo1: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  return { y: Number(map.year), mo1: Number(map.month) - 1, d: Number(map.day) }
}

function parseHm(hm: string): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return { h, mi }
}

/**
 * Build the working-hours slot grid across [fromISO, toISO], stepping by
 * (slotMinutes + bufferMinutes) within each day's window, each slot slotMinutes
 * long. Times are wall-clock in working_hours.timezone. Only slots that start at
 * or after `fromISO` and END at or before `toISO` are returned.
 */
export function generateGridSlots(
  wh: WorkingHours,
  slotMinutes: number,
  bufferMinutes: number,
  fromISO: string,
  toISO: string
): Slot[] {
  const tz = wh.timezone || 'UTC'
  const fromMs = new Date(fromISO).getTime()
  const toMs = new Date(toISO).getTime()
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return []
  if (!(slotMinutes > 0)) return []
  const step = slotMinutes + Math.max(0, bufferMinutes)

  const slots: Slot[] = []
  // Anchor a pure date counter at UTC-midnight of the local start date, and walk
  // one calendar day at a time (start a day early / end a day late to catch
  // windows whose UTC instant crosses the boundary).
  const startYmd = localYmd(new Date(fromMs), tz)
  let cursor = Date.UTC(startYmd.y, startYmd.mo1, startYmd.d) - 24 * 3600_000
  const endYmd = localYmd(new Date(toMs), tz)
  const lastAnchor = Date.UTC(endYmd.y, endYmd.mo1, endYmd.d) + 24 * 3600_000

  for (; cursor <= lastAnchor; cursor += 24 * 3600_000) {
    const dc = new Date(cursor)
    const y = dc.getUTCFullYear()
    const mo1 = dc.getUTCMonth()
    const d = dc.getUTCDate()
    const weekdayKey = WEEKDAY_KEYS[dc.getUTCDay()]
    const win = wh[weekdayKey]
    if (!win) continue
    const s = parseHm(win.start)
    const e = parseHm(win.end)
    if (!s || !e) continue
    const startMin = s.h * 60 + s.mi
    const endMin = e.h * 60 + e.mi
    if (endMin <= startMin) continue

    for (let m = startMin; m + slotMinutes <= endMin; m += step) {
      const slotStart = zonedWallToUtc(y, mo1, d, Math.floor(m / 60), m % 60, tz)
      const startMs = slotStart.getTime()
      const endMs = startMs + slotMinutes * 60_000
      if (startMs >= fromMs && endMs <= toMs) {
        slots.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() })
      }
    }
  }
  // De-dupe (the boundary days can re-emit) and sort.
  const seen = new Set<string>()
  return slots
    .filter((sl) => (seen.has(sl.start) ? false : (seen.add(sl.start), true)))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}

// Drop any slot that overlaps a busy interval. Overlap: slotStart < busyEnd AND
// slotEnd > busyStart. Invalid/unparseable busy entries are ignored.
export function subtractBusy(slots: Slot[], busy: Interval[]): Slot[] {
  const intervals = busy
    .map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s)
  if (intervals.length === 0) return slots
  return slots.filter((sl) => {
    const s = new Date(sl.start).getTime()
    const e = new Date(sl.end).getTime()
    return !intervals.some((b) => s < b.e && e > b.s)
  })
}

// Clamp a requested [from,to] to [now, now + windowDays]. Returns null when the
// window is empty (to <= from). `nowMs` is injected so callers stay testable.
export function clampWindow(
  fromISO: string | undefined,
  toISO: string | undefined,
  windowDays: number,
  nowMs: number
): { from: string; to: string } | null {
  const reqFrom = fromISO && Number.isFinite(new Date(fromISO).getTime()) ? new Date(fromISO).getTime() : nowMs
  const maxTo = nowMs + windowDays * 24 * 3600_000
  const reqTo = toISO && Number.isFinite(new Date(toISO).getTime()) ? new Date(toISO).getTime() : maxTo
  const from = Math.max(reqFrom, nowMs)
  const to = Math.min(reqTo, maxTo)
  if (to <= from) return null
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}
