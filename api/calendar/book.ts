import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { isZoomConfigured, getSchedulerAvailability, createZoomMeeting, slotMinutes } from '../../lib/zoom'
import { buildBookingIcs } from '../../lib/ics'
import { sendBookingConfirmationEmail } from '../../lib/email'
import { loadBookingQuestions } from '../../lib/bookingQuestions'

// POST /api/calendar/book
// Body: { slot_start, first_name, last_name, email, answers?, notes? }
//   - answers is a MAP keyed by question id: { [questionId]: value }.
//   - legacy { name } (split on first space) is still accepted for back-compat.
// Public (optional session decode attaches user_id). Reserves the slot, creates
// the Zoom meeting, stores the booking + a custom_answers snapshot, best-effort
// emails the confirmation + .ics, and returns { booking_id, join_url, start_time }.
//
// Ordering matters for no-double-booking: RESERVE the row first (a partial
// unique index on active start_time makes a concurrent second reservation fail
// 409), THEN create the Zoom meeting. If the meeting create fails, the
// reservation is deleted so the slot frees — never a held slot with no meeting.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  if (!isZoomConfigured()) {
    return res.status(503).json({ error: 'calendar_unavailable' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const slotStart = typeof body.slot_start === 'string' ? body.slot_start : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''

  // Name: prefer first_name + last_name; fall back to a legacy { name }.
  const firstName = typeof body.first_name === 'string' ? body.first_name.trim() : ''
  const lastName = typeof body.last_name === 'string' ? body.last_name.trim() : ''
  const legacyName = typeof body.name === 'string' ? body.name.trim() : ''
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || legacyName

  if (!slotStart || Number.isNaN(new Date(slotStart).getTime())) {
    return res.status(400).json({ error: 'slot_start (ISO datetime) required' })
  }
  if (!name) return res.status(400).json({ error: 'first_name and last_name required' })
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' })
  }

  // Custom-question answers: a map { [questionId]: value }. Validate against
  // the current definitions and build a self-contained snapshot to store, so
  // the booking keeps its context even if questions are later edited/deleted.
  const answersMap = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers
    : {}) as Record<string, unknown>
  const questions = await loadBookingQuestions()
  const customAnswers: Array<{ id: string; label: string; type: string; answer: string }> = []
  for (const q of questions) {
    const raw = answersMap[q.id]
    const answer = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : ''
    if (q.required && !answer) {
      return res.status(400).json({ error: 'question_required', question: q.label })
    }
    if (q.type === 'dropdown' && answer && !(q.options || []).includes(answer)) {
      return res.status(400).json({ error: 'invalid_option', question: q.label })
    }
    customAnswers.push({ id: q.id, label: q.label, type: q.type, answer })
  }

  const startMs = new Date(slotStart).getTime()
  if (startMs <= Date.now()) {
    return res.status(400).json({ error: 'slot_start must be in the future' })
  }
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(startMs + slotMinutes() * 60_000).toISOString()

  // Optional session — attach the member if one is logged in; anonymous is fine.
  let userId: string | null = null
  const token = getSessionFromRequest(req as any)
  if (token) {
    const payload = await verifySessionToken(token)
    if (payload) userId = payload.userId
  }

  try {
    // 1) Confirm the slot is genuinely still open per Zoom Scheduler.
    const dayStart = new Date(startMs - 60_000).toISOString()
    const dayEnd = new Date(startMs + slotMinutes() * 60_000 + 60_000).toISOString()
    const slots = await getSchedulerAvailability(dayStart, dayEnd)
    const stillOpen = slots.some((s) => new Date(s.start).getTime() === startMs)
    if (!stillOpen) {
      return res.status(409).json({ error: 'slot_taken' })
    }

    // 2) Reserve the slot (DB unique index is the concurrency backstop).
    const { data: reserved, error: reserveErr } = await supabase
      .from('bookings')
      .insert({
        user_id: userId,
        name,
        email,
        start_time: startIso,
        end_time: endIso,
        status: 'active',
        custom_answers: customAnswers,
      })
      .select('id')
      .single()

    if (reserveErr) {
      if ((reserveErr as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'slot_taken' })
      }
      throw reserveErr
    }

    // 3) Create the Zoom meeting; on failure free the reservation.
    let meeting: { id: string; join_url: string; start_time: string }
    try {
      meeting = await createZoomMeeting(`MTM call with ${name}`, startIso)
    } catch (zoomErr) {
      await supabase.from('bookings').delete().eq('id', reserved.id)
      console.error('[calendar/book] zoom create failed — reservation released', zoomErr)
      return res.status(502).json({ error: 'Failed to create meeting' })
    }

    // 4) Attach meeting details to the row.
    await supabase
      .from('bookings')
      .update({ zoom_meeting_id: meeting.id, zoom_join_url: meeting.join_url })
      .eq('id', reserved.id)

    // 5) Best-effort branded confirmation with .ics — never fails the booking.
    const startLabel = new Date(startIso).toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' (UTC)'
    const ics = buildBookingIcs({
      uid: `booking-${reserved.id}@microtrainingmethod.com`,
      startUtcISO: startIso,
      endUtcISO: endIso,
      summary: 'Micro-Training Method call',
      description: `Your call is booked. Join here: ${meeting.join_url}`,
      joinUrl: meeting.join_url,
      organizerEmail: process.env.ZOOM_HOST_EMAIL || 'noreply@mail.microtrainingmethod.com',
      attendeeEmail: email,
    })
    await sendBookingConfirmationEmail({ email, name, startLabel, joinUrl: meeting.join_url, icsContent: ics })

    return res.status(200).json({
      booking_id: reserved.id,
      join_url: meeting.join_url,
      start_time: startIso,
    })
  } catch (err) {
    console.error('[calendar/book] POST', err)
    return res.status(500).json({ error: 'Failed to book' })
  }
}
