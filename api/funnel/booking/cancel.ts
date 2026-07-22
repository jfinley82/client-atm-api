import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { verifyManageToken } from '../../../lib/funnelLeadToken'
import { loadBooking, resolveFunnelAndLead, formatInTz } from '../../../lib/bookingManage'
import { deleteCalendarEvent } from '../../../lib/googleCalendar'
import { loadUserAvailability } from '../../../lib/availabilitySettings'
import { cancelLeadQueue } from '../../../lib/funnelNurture'
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
  if (!booking || !booking.coach_user_id) return res.status(404).json({ error: 'not_found' })

  if (booking.status === 'canceled') return res.status(200).json({ ok: true })
  if (new Date(booking.start_time).getTime() <= Date.now()) return res.status(409).json({ error: 'past_call' })

  try {
    // 1) Delete the calendar event (best-effort; the helper tolerates 404/410).
    if (booking.google_event_id) {
      await deleteCalendarEvent(booking.coach_user_id, booking.google_event_id)
    }

    // 2) Free the slot — the unique index is scoped WHERE status='active'.
    const { error: updErr } = await supabase.from('bookings').update({ status: 'canceled' }).eq('id', booking.id).eq('status', 'active')
    if (updErr) throw updErr

    // 3) Cancel the lead's pending reminders (cancelLeadQueue cancels every
    // still-queued send for the lead at Resend; for a booked lead that is the
    // 24h/1h reminders). Skip if no lead resolves.
    const [settings, ctx, coachRes] = await Promise.all([
      loadUserAvailability(booking.coach_user_id),
      resolveFunnelAndLead(booking.coach_user_id, booking.email),
      supabase.from('users').select('email').eq('id', booking.coach_user_id).maybeSingle(),
    ])
    if (ctx.leadId) await cancelLeadQueue(ctx.leadId)

    // 4) Notify the coach (best-effort).
    const coachEmail = (coachRes.data as { email?: string } | null)?.email || ''
    await sendCoachBookingChange({
      coachEmail,
      coachUserId: booking.coach_user_id,
      leadName: booking.name || '',
      leadEmail: booking.email,
      change: 'canceled',
      oldLabel: formatInTz(booking.start_time, settings.working_hours?.timezone),
    })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[funnel/booking/cancel]', err)
    return res.status(500).json({ error: 'cancel_failed' })
  }
}
