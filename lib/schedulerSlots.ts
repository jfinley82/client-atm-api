import { supabase } from './supabase'
import { getSchedulerAvailability, slotMinutes, Slot } from './zoom'

// ── Shared-scheduler slots: ONE source for listing and validating ────────────
// The booking page lists slots from GET /api/calendar/availability, and
// POST /api/calendar/book must accept exactly what that call offered. Every
// slot_taken outage on this path has come from those two computing availability
// differently:
//
//   * the book handler queried Zoom over a ~31-minute window (start-60s ..
//     start+slot+60s) while the page queried 14 days. Zoom's available_times is
//     DAY-granular (days[].spots[]), so the narrow query came back with nothing
//     to match and every slot was rejected.
//   * a later attempt validated against the coach's own availability engine
//     instead, which yields nothing at all for a coach who has never configured
//     custom availability — so it still rejected every listed slot.
//
// Both endpoints now call the functions below, so the list and the check cannot
// diverge again: same engine, same booked-slot subtraction, and a window that is
// guaranteed to contain the slot being validated.

// Matches the default window the public availability endpoint advertises.
export const DEFAULT_WINDOW_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

// ZOOM'S HARD LIMIT, and the third way this file's two callers have diverged.
//
// available_times rejects any window wider than 45 days:
//   400 INVALID_ARGUMENT "The timeMax and timeMin intervals cannot exceed 45 days."
//
// The public endpoint took `from` and `to` straight off the query string and
// passed them through unbounded — it only fell back to a default when they were
// absent or unparseable, so a well-formed WIDE window reached Zoom untouched and
// came back 400 every single time. That surfaced as a deterministic 502 on
// GET /api/calendar/availability, and downstream as a booking page rendering a
// calendar with every day disabled and nothing said.
//
// isSchedulerSlotOpen had the same bug from the other end: it widens `to` to
// cover the slot being validated, so a start time more than 45 days out blew the
// limit and made that slot impossible to BOOK as well as to list.
//
// Clamping lives here rather than in either caller because this file exists to
// stop exactly that divergence. api/funnel/availability.ts already clamps to
// booking_window_days; the shared scheduler path clamped nowhere.
export const ZOOM_MAX_WINDOW_DAYS = 45
// A minute under the stated maximum. Zoom documents "cannot exceed 45 days"
// without saying whether the comparison is inclusive or day-granular, and being
// sixty seconds short of the limit costs nothing while guessing wrong costs a
// 400.
const ZOOM_MAX_WINDOW_MS = ZOOM_MAX_WINDOW_DAYS * DAY_MS - 60_000

/**
 * Coerce an arbitrary [from, to] into a window Zoom will actually answer.
 *
 * Invalid dates fall back to now / now + DEFAULT_WINDOW_DAYS, an inverted range
 * is corrected rather than rejected, and an over-wide range is truncated from
 * the END — a caller asking for six months gets the first 45 days, which is
 * strictly more useful than the 502 it used to get.
 */
export function clampSchedulerWindow(fromIso?: string | null, toIso?: string | null): { fromIso: string; toIso: string } {
  const now = Date.now()
  const parse = (v: unknown): number | null => {
    if (typeof v !== 'string' || !v.trim()) return null
    const ms = new Date(v).getTime()
    return Number.isFinite(ms) ? ms : null
  }

  let fromMs = parse(fromIso) ?? now
  let toMs = parse(toIso) ?? fromMs + DEFAULT_WINDOW_DAYS * DAY_MS

  // An inverted window is a caller mistake, not a reason to fail: read it as the
  // range they described.
  if (toMs < fromMs) [fromMs, toMs] = [toMs, fromMs]

  if (toMs - fromMs > ZOOM_MAX_WINDOW_MS) toMs = fromMs + ZOOM_MAX_WINDOW_MS

  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() }
}

// Open slots from the shared Zoom Scheduler, minus any slot we already hold an
// active booking for (so a just-booked time disappears immediately even if
// Zoom's own availability lags). This subtraction is part of the contract: the
// validator has to apply it too, or booking would accept a time the page had
// already removed.
export async function listOpenSchedulerSlots(rawFromIso: string, rawToIso: string): Promise<Slot[]> {
  // Clamped here, not at the endpoint, so every caller is covered by one rule.
  const { fromIso, toIso } = clampSchedulerWindow(rawFromIso, rawToIso)

  const slots = await getSchedulerAvailability(fromIso, toIso)

  const { data: booked, error } = await supabase
    .from('bookings')
    .select('start_time')
    .eq('status', 'active')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
  if (error) throw error

  const takenMs = new Set((booked || []).map((b) => new Date(b.start_time as string).getTime()))
  return slots.filter((s) => !takenMs.has(new Date(s.start).getTime()))
}

// Is this exact start time one of the open slots the page would have listed?
//
// The window deliberately spans at least the page's default 14 days AND the
// requested slot, so a slot the page could have shown is always inside the range
// we re-query. Querying a tight window around the slot is what broke this before:
// Zoom answers by day, not by minute.
export async function isSchedulerSlotOpen(startIso: string): Promise<boolean> {
  const startMs = new Date(startIso).getTime()
  if (!Number.isFinite(startMs)) return false

  const now = Date.now()
  let fromMs = Math.min(now, startMs - 60_000)
  let toMs = Math.max(now + DEFAULT_WINDOW_DAYS * DAY_MS, startMs + slotMinutes() * 60_000 + 60_000)

  // If the slot is far enough out that [now, slot] exceeds Zoom's 45-day cap,
  // anchor the window on the SLOT instead of on now. Letting the generic clamp
  // truncate the end would cut the slot out of its own validation window and
  // reject a booking the page legitimately offered — the same class of failure
  // as the two in the header, arriving by a third route.
  //
  // A day either side, not a tight bracket: Zoom answers available_times by DAY,
  // and querying a ~31-minute window is what broke this the first time.
  if (toMs - fromMs > ZOOM_MAX_WINDOW_MS) {
    fromMs = startMs - DAY_MS
    toMs = startMs + slotMinutes() * 60_000 + DAY_MS
  }

  const open = await listOpenSchedulerSlots(new Date(fromMs).toISOString(), new Date(toMs).toISOString())
  return open.some((s) => new Date(s.start).getTime() === startMs)
}
