import { supabase } from './supabase'
import { loadUserAvailability, AvailabilitySettings } from './availabilitySettings'
import { generateGridSlots, subtractBusy, clampWindow, Slot, Interval } from './availability'
import { getValidAccessToken, fetchFreeBusy } from './googleCalendar'

// The ONE availability builder both the public /api/funnel/availability endpoint
// and the booking slot-check use, so what the page shows is exactly what the
// booking validates (no drift). Open slots = the owner's working-hours grid,
// MINUS Google free/busy (when connected), MINUS the owner's active bookings.

async function openSlotsForWindow(
  ownerUserId: string,
  settings: AvailabilitySettings,
  window: { from: string; to: string }
): Promise<{ slots: Slot[]; connected: boolean }> {
  const grid = generateGridSlots(settings.working_hours, settings.slot_minutes, settings.buffer_minutes, window.from, window.to)

  const busy: Interval[] = []
  // Google free/busy when connected — best-effort; a Google error degrades to
  // bookings-only rather than failing.
  const conn = await getValidAccessToken(ownerUserId)
  if (conn) {
    try {
      busy.push(...(await fetchFreeBusy(conn.access_token, conn.calendar_id, window.from, window.to)))
    } catch (err) {
      console.error('[funnelAvailability] freeBusy failed, bookings-only', err)
    }
  }

  // The owner's existing active MTM bookings in the window.
  const { data: bookings } = await supabase
    .from('bookings')
    .select('start_time, end_time')
    .eq('coach_user_id', ownerUserId)
    .eq('status', 'active')
    .lt('start_time', window.to)
    .gt('end_time', window.from)
  for (const b of bookings || []) {
    if (typeof b.start_time === 'string' && typeof b.end_time === 'string') {
      busy.push({ start: b.start_time, end: b.end_time })
    }
  }

  return { slots: subtractBusy(grid, busy), connected: !!conn }
}

// Open slots for a coach across [fromIso, toIso], clamped to booking_window_days.
export async function computeOpenSlots(
  ownerUserId: string,
  fromIso: string | undefined,
  toIso: string | undefined
): Promise<{ slots: Slot[]; connected: boolean }> {
  const settings = await loadUserAvailability(ownerUserId)
  const window = clampWindow(fromIso, toIso, settings.booking_window_days, Date.now())
  if (!window) return { slots: [], connected: false }
  return openSlotsForWindow(ownerUserId, settings, window)
}

// Is `startIso` a genuine open slot start for this coach right now? Uses the same
// builder as the page, over a tight window covering that slot. This is the
// authoritative check the booking runs before reserving.
export async function isSlotOpen(ownerUserId: string, startIso: string): Promise<boolean> {
  const startMs = new Date(startIso).getTime()
  if (!Number.isFinite(startMs)) return false
  const settings = await loadUserAvailability(ownerUserId)
  const window = clampWindow(
    new Date(startMs - 60_000).toISOString(),
    new Date(startMs + settings.slot_minutes * 60_000 + 60_000).toISOString(),
    settings.booking_window_days,
    Date.now()
  )
  if (!window) return false
  const { slots } = await openSlotsForWindow(ownerUserId, settings, window)
  return slots.some((s) => new Date(s.start).getTime() === startMs)
}
