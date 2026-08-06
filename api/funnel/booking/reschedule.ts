import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { verifyManageToken } from '../../../lib/funnelLeadToken'
import { loadBooking, resolveFunnelAndLead, buildBookingManageUrl, bookingJoinUrl, formatInTz, MANAGE_CUTOFF_MS, RESCHEDULE_CAP } from '../../../lib/bookingManage'
import { loadUserAvailability } from '../../../lib/availabilitySettings'
import { isSlotOpen } from '../../../lib/funnelAvailability'
import { updateCalendarEventTime } from '../../../lib/googleCalendar'
import { slotMinutes, updateZoomMeetingTime } from '../../../lib/zoom'
import { isSchedulerSlotOpen } from '../../../lib/schedulerSlots'
import { resolveBookingBrand } from '../../../lib/email'
import { bookingTimeLabel } from '../../../lib/bookingTimezone'
import { cancelBookingReminders, scheduleBookingReminders } from '../../../lib/funnelNurture'
import { buildBookingIcs } from '../../../lib/ics'
import { sendBookingConfirmationEmail, sendCoachBookingChange } from '../../../lib/email'

// POST /api/funnel/booking/reschedule — body { token, slot_start }. PUBLIC,
// keyed by the manage token. Moves the call to another open slot, keeping the
// same calendar event + meeting link. DB-first ordering: reserve the new time in
// Postgres (the unique index is the real concurrency guard) BEFORE patching
// Google, and roll the row back if the patch fails so the two never diverge.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const bookingId = verifyManageToken(typeof body.token === 'string' ? body.token : '')
  if (!bookingId) return res.status(400).json({ error: 'invalid_token' })

  const booking = await loadBooking(bookingId)
  // Null coach_user_id means SHARED ZOOM, not missing — the public /book path and
  // any funnel whose owner has no Google connection both land there.
  if (!booking) return res.status(404).json({ error: 'not_found' })
  if (booking.status === 'canceled') return res.status(409).json({ error: 'canceled' })
  // Distinct reasons so the page can message each. Cutoff covers past/near calls.
  if (new Date(booking.start_time).getTime() - Date.now() < MANAGE_CUTOFF_MS) return res.status(409).json({ error: 'cutoff' })
  if (booking.reschedule_count >= RESCHEDULE_CAP) return res.status(409).json({ error: 'cap' })

  const slotStart = typeof body.slot_start === 'string' ? body.slot_start.trim() : ''
  const newStartMs = new Date(slotStart).getTime()
  // The new time must also sit outside the cutoff, so a lead can't move a call
  // into the no-change window.
  if (!Number.isFinite(newStartMs) || newStartMs - Date.now() < MANAGE_CUTOFF_MS) return res.status(400).json({ error: 'invalid_slot' })

  const coach = booking.coach_user_id
  const sharedZoom = !coach
  const prevStart = booking.start_time
  const prevEnd = booking.end_time
  const prevCount = booking.reschedule_count

  try {
    // Duration and slot source both come from whichever engine owns this
    // booking, so the check here matches the list the manage page rendered —
    // the invariant that every slot_taken outage on this path has come from
    // breaking.
    const settings = coach ? await loadUserAvailability(coach) : null
    const tz = settings?.working_hours?.timezone
    const durationMin = settings ? settings.slot_minutes : slotMinutes()
    const newStartIso = new Date(newStartMs).toISOString()
    const newEndIso = new Date(newStartMs + durationMin * 60_000).toISOString()

    const stillOpen = coach ? await isSlotOpen(coach, newStartIso) : await isSchedulerSlotOpen(newStartIso)
    if (!stillOpen) return res.status(409).json({ error: 'slot_taken' })

    // DB-first reservation + atomic cap increment. Two guards:
    //  - the per-coach unique index on (coach_user_id, start_time) WHERE
    //    status='active' → a 23505 means another booking holds the slot.
    //  - a compare-and-swap on reschedule_count (eq the value we read) → two
    //    concurrent moves can't both slip past the cap: the second's WHERE no
    //    longer matches once the first commits, so it gets 0 rows. Setting an
    //    absolute prevCount+1 (not a bare < CAP guard) is what closes the
    //    count=0 concurrent-double-move hole.
    const { data: moved, error: updErr } = await supabase
      .from('bookings')
      .update({ start_time: newStartIso, end_time: newEndIso, reschedule_count: prevCount + 1 })
      .eq('id', booking.id)
      .eq('status', 'active')
      .eq('reschedule_count', prevCount)
      .select('id')
      .maybeSingle()
    if (updErr) {
      if ((updErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'slot_taken' })
      throw updErr
    }
    // No row matched: the CAS lost to a concurrent move (or the booking changed).
    // Treat as the cap being hit rather than burning a retry.
    if (!moved) return res.status(409).json({ error: 'cap' })

    // Patch the calendar event in place. On failure, roll the row back
    // (start/end AND the count, so a failed move doesn't burn a try) so the DB
    // and calendar never diverge.
    // Same rollback contract on both systems: if the meeting cannot be moved,
    // put the row back so the database and the meeting never disagree.
    if (coach && booking.google_event_id) {
      const ok = await updateCalendarEventTime(coach, booking.google_event_id, newStartIso, newEndIso, tz)
      if (!ok) {
        await supabase.from('bookings').update({ start_time: prevStart, end_time: prevEnd, reschedule_count: prevCount }).eq('id', booking.id)
        return res.status(502).json({ error: 'calendar_update_failed' })
      }
    }
    if (sharedZoom && booking.zoom_meeting_id) {
      const ok = await updateZoomMeetingTime(booking.zoom_meeting_id, newStartIso)
      if (!ok) {
        await supabase.from('bookings').update({ start_time: prevStart, end_time: prevEnd, reschedule_count: prevCount }).eq('id', booking.id)
        return res.status(502).json({ error: 'calendar_update_failed' })
      }
    }

    // Reschedule reminders + send an updated confirmation + notify the coach.
    // All best-effort — the move already succeeded in both systems above.
    const ctx = coach ? await resolveFunnelAndLead(coach, booking.email) : { funnel: null, leadId: null }
    const meetingUrl = bookingJoinUrl(booking)
    const manageUrl = buildBookingManageUrl(booking.id, (ctx.funnel?.subdomain as string) || null)

    // Cancel the whole set against the OLD time first, then schedule a fresh set
    // against the new one, so no queued row survives pointing at a time that no
    // longer exists.
    await cancelBookingReminders(booking.id)
    await scheduleBookingReminders({
      brand: await resolveBookingBrand(coach),
      funnelId: ctx.funnel ? String(ctx.funnel.id) : booking.funnel_id,
      leadId: ctx.leadId,
      email: booking.email,
      startIso: newStartIso,
      joinUrl: meetingUrl,
      bookingId: booking.id,
      manageUrl,
      timezone: booking.timezone,
    })

    const { data: conn } = coach
      ? await supabase
          .from('calendar_connections')
          .select('calendar_email')
          .eq('user_id', coach)
          .eq('provider', 'google')
          .maybeSingle()
      : { data: null }
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
      // The visitor's own zone, the same rendering the confirmation uses.
      startLabel: bookingTimeLabel(newStartIso, booking.timezone),
      joinUrl: meetingUrl,
      icsContent: ics,
      manageUrl,
      ...(ctx.funnel ? { funnelId: String(ctx.funnel.id), leadId: ctx.leadId } : {}),
      ...(coach ? { coachUserId: coach } : {}),
    })

    if (!coach) return res.status(200).json({ ok: true, start_time: newStartIso })

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
