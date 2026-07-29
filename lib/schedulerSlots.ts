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

// Open slots from the shared Zoom Scheduler, minus any slot we already hold an
// active booking for (so a just-booked time disappears immediately even if
// Zoom's own availability lags). This subtraction is part of the contract: the
// validator has to apply it too, or booking would accept a time the page had
// already removed.
export async function listOpenSchedulerSlots(fromIso: string, toIso: string): Promise<Slot[]> {
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
  const fromIso = new Date(Math.min(now, startMs - 60_000)).toISOString()
  const toIso = new Date(
    Math.max(now + DEFAULT_WINDOW_DAYS * DAY_MS, startMs + slotMinutes() * 60_000 + 60_000)
  ).toISOString()

  const open = await listOpenSchedulerSlots(fromIso, toIso)
  return open.some((s) => new Date(s.start).getTime() === startMs)
}
