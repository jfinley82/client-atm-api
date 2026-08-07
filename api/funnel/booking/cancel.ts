import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { verifyManageToken } from '../../../lib/funnelLeadToken'
import { loadBooking, formatInTz, MANAGE_CUTOFF_MS } from '../../../lib/bookingManage'
import { deleteCalendarEvent } from '../../../lib/googleCalendar'
import { deleteZoomMeeting } from '../../../lib/zoom'
import { loadUserAvailability } from '../../../lib/availabilitySettings'
import { cancelBookingReminders } from '../../../lib/funnelNurture'
import { sendCoachBookingChange } from '../../../lib/email'

// POST /api/funnel/booking/cancel — body { token }. PUBLIC, keyed by the manage
// token. Frees the slot, deletes the calendar event, cancels the lead's pending
// reminders, and notifies the coach. Idempotent on an already-canceled booking.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const bookingId = verifyManageToken(typeof body.token === 'string' ? body.token : '')
  if (!bookingId) return res.status(400).json({ error: 'invalid_token' })

  const booking = await loadBooking(bookingId)
  // A null coach_user_id is a SHARED-ZOOM booking, not a missing one. Rejecting
  // it here is why the manage link never worked for a public /book booking —
  // nor, it turns out, for a funnel booking whose owner has no Google
  // connection, since that path deliberately leaves coach_user_id null too.
  if (!booking) return res.status(404).json({ error: 'not_found' })

  if (booking.status === 'canceled') return res.status(200).json({ ok: true })
  // One check covers both "inside the 3-hour window" and "already started/passed".
  if (new Date(booking.start_time).getTime() - Date.now() < MANAGE_CUTOFF_MS) return res.status(409).json({ error: 'cutoff' })

  try {
    // 1) Tear down the meeting itself, on whichever system holds it. Both
    // helpers tolerate an already-deleted target, because cancel is idempotent.
    if (booking.coach_user_id && booking.google_event_id) {
      await deleteCalendarEvent(booking.coach_user_id, booking.google_event_id)
    }
    if (booking.zoom_meeting_id) {
      await deleteZoomMeeting(booking.zoom_meeting_id)
    }

    // 2) Free the slot — the unique index is scoped WHERE status='active'.
    // canceled_by 'client': the attendee gave the slot back themselves. This
    // path refuses inside MANAGE_CUTOFF_MS above, so every row it writes is an
    // EARLY cancel by construction — a late client cancellation cannot be
    // produced through our own API at all.
    const { error: updErr } = await supabase
      .from('bookings')
      .update({ status: 'canceled', canceled_at: new Date().toISOString(), canceled_by: 'client' })
      .eq('id', booking.id)
      .eq('status', 'active')
    if (updErr) throw updErr

    // 3) Cancel THIS booking's pending reminders (by booking_id, so the lead's
    // other bookings keep theirs). Nurture was already canceled at booking time.
    // The reminders stop regardless of which path booked it — cancelBookingReminders
    // has always keyed off booking_id rather than the funnel, so it needed no
    // change here. Someone who cancels and keeps getting reminders is worse off
    // than someone who never had the link.
    await cancelBookingReminders(booking.id)

    // 4) Notify the coach (best-effort). A shared-Zoom PUBLIC booking has no
    // coach to notify: it is MTM's own call, and there is no per-coach
    // notification preference to consult. Left silent rather than invented.
    if (booking.coach_user_id) {
      const [settings, coachRes] = await Promise.all([
        loadUserAvailability(booking.coach_user_id),
        supabase.from('users').select('email').eq('id', booking.coach_user_id).maybeSingle(),
      ])
      await sendCoachBookingChange({
        coachEmail: (coachRes.data as { email?: string } | null)?.email || '',
        coachUserId: booking.coach_user_id,
        leadName: booking.name || '',
        leadEmail: booking.email,
        change: 'canceled',
        oldLabel: formatInTz(booking.start_time, settings.working_hours?.timezone),
      })
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[funnel/booking/cancel]', err)
    return res.status(500).json({ error: 'cancel_failed' })
  }
}
