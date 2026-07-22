import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { verifyManageToken } from '../../../lib/funnelLeadToken'
import { loadBooking, resolveFunnelAndLead, buildManageUrl, formatInTz } from '../../../lib/bookingManage'
import { loadUserAvailability } from '../../../lib/availabilitySettings'
import { isSlotOpen } from '../../../lib/funnelAvailability'
import { updateCalendarEventTime } from '../../../lib/googleCalendar'
import { cancelBookingReminders, scheduleBookingReminders } from '../../../lib/funnelNurture'
import { buildBookingIcs } from '../../../lib/ics'
import { sendBookingConfirmationEmail, sendCoachBookingChange } from '../../../lib/email'

// POST /api/funnel/booking/reschedule — body { token, slot_start }. PUBLIC,
// keyed by the manage token. Moves the call to another open slot, keeping the
// same calendar event + meeting link. DB-first ordering: reserve the new time in
// Postgres (the unique index is the real concurrency guard) BEFORE patching
// Google, and roll the row back if the patch fails so the two never diverge.
function utcLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' (UTC)'
  } catch {
    return iso
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const bookingId = verifyManageToken(typeof body.token === 'string' ? body.token : '')
  if (!bookingId) return res.status(400).json({ error: 'invalid_token' })

  const booking = await loadBooking(bookingId)
  if (!booking || !booking.coach_user_id) return res.status(404).json({ error: 'not_found' })
  if (booking.status === 'canceled') return res.status(409).json({ error: 'canceled' })
  if (new Date(booking.start_time).getTime() <= Date.now()) return res.status(409).json({ error: 'past_call' })

  const slotStart = typeof body.slot_start === 'string' ? body.slot_start.trim() : ''
  const newStartMs = new Date(slotStart).getTime()
  if (!Number.isFinite(newStartMs) || newStartMs <= Date.now()) return res.status(400).json({ error: 'invalid_slot' })

  const coach = booking.coach_user_id
  const prevStart = booking.start_time
  const prevEnd = booking.end_time

  try {
    const settings = await loadUserAvailability(coach)
    const tz = settings.working_hours?.timezone
    const newStartIso = new Date(newStartMs).toISOString()
    const newEndIso = new Date(newStartMs + settings.slot_minutes * 60_000).toISOString()

    // Confirm the new slot is genuinely open (same engine the page shows).
    if (!(await isSlotOpen(coach, newStartIso))) return res.status(409).json({ error: 'slot_taken' })

    // DB-first reservation. The per-coach unique index on (coach_user_id,
    // start_time) WHERE status='active' is the authoritative guard — a 23505 here
    // means another booking already holds the slot.
    const { data: moved, error: updErr } = await supabase
      .from('bookings')
      .update({ start_time: newStartIso, end_time: newEndIso })
      .eq('id', booking.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle()
    if (updErr) {
      if ((updErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'slot_taken' })
      throw updErr
    }
    if (!moved) return res.status(409).json({ error: 'slot_taken' })

    // Patch the calendar event in place. On failure, roll the row back so the DB
    // and calendar never diverge.
    if (booking.google_event_id) {
      const ok = await updateCalendarEventTime(coach, booking.google_event_id, newStartIso, newEndIso, tz)
      if (!ok) {
        await supabase.from('bookings').update({ start_time: prevStart, end_time: prevEnd }).eq('id', booking.id)
        return res.status(502).json({ error: 'calendar_update_failed' })
      }
    }

    // Reschedule reminders + send an updated confirmation + notify the coach.
    // All best-effort — the move already succeeded in both systems above.
    const ctx = await resolveFunnelAndLead(coach, booking.email)
    const meetingUrl = booking.meeting_url || ''
    const manageUrl = ctx.funnel?.subdomain ? buildManageUrl(String(ctx.funnel.subdomain), booking.id) : undefined

    if (ctx.leadId && ctx.funnel) {
      await cancelBookingReminders(ctx.leadId)
      await scheduleBookingReminders(ctx.funnel, ctx.leadId, booking.email, newStartIso, meetingUrl, manageUrl)
    }

    const { data: conn } = await supabase
      .from('calendar_connections')
      .select('calendar_email')
      .eq('user_id', coach)
      .eq('provider', 'google')
      .maybeSingle()
    const organizerEmail = (conn as { calendar_email?: string } | null)?.calendar_email || process.env.ZOOM_HOST_EMAIL || 'noreply@mail.microtrainingmethod.com'

    const ics = buildBookingIcs({
      uid: `booking-${booking.id}@microtrainingmethod.com`,
      startUtcISO: newStartIso,
      endUtcISO: newEndIso,
      summary: 'Micro-Training Method call',
      description: `Your call is booked. Join here: ${meetingUrl}`,
      joinUrl: meetingUrl,
      organizerEmail,
      attendeeEmail: booking.email,
    })
    await sendBookingConfirmationEmail({
      email: booking.email,
      name: booking.name,
      startLabel: utcLabel(newStartIso),
      joinUrl: meetingUrl,
      icsContent: ics,
      ...(ctx.funnel ? { funnelId: String(ctx.funnel.id), leadId: ctx.leadId, coachUserId: coach, manageUrl } : { coachUserId: coach, manageUrl }),
    })

    const { data: coachUser } = await supabase.from('users').select('email').eq('id', coach).maybeSingle()
    await sendCoachBookingChange({
      coachEmail: (coachUser as { email?: string } | null)?.email || '',
      coachUserId: coach,
      leadName: booking.name || '',
      leadEmail: booking.email,
      change: 'moved',
      oldLabel: formatInTz(prevStart, tz),
      newLabel: formatInTz(newStartIso, tz),
    })

    return res.status(200).json({ ok: true, start_time: newStartIso })
  } catch (err) {
    console.error('[funnel/booking/reschedule]', err)
    return res.status(500).json({ error: 'reschedule_failed' })
  }
}
