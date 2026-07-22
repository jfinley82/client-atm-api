import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { isZoomConfigured, getSchedulerAvailability, createZoomMeeting, slotMinutes } from '../../lib/zoom'
import { buildBookingIcs } from '../../lib/ics'
import { sendBookingConfirmationEmail, sendCoachBookingNotification } from '../../lib/email'
import { loadBookingQuestions, loadFunnelBookingQuestions, validateBookingAnswers, ValidatedAnswer } from '../../lib/bookingQuestions'
import { resolveLiveFunnel } from '../../lib/funnels'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { isSlotOpen } from '../../lib/funnelAvailability'
import { getValidAccessToken, createCalendarEvent, ValidToken } from '../../lib/googleCalendar'
import { loadBusinessSettings } from '../../lib/businessSettings'

// POST /api/calendar/book
// Body: { slot_start, first_name, last_name, email, answers?, funnel_id? }
//   - answers is a MAP keyed by question id: { [questionId]: value }.
//
// Two paths:
//   FUNNEL GOOGLE PATH — when funnel_id resolves to a live funnel whose OWNER has
//   a Google connection: validate the slot against the SAME engine the funnel
//   book page shows (isSlotOpen), create the real event on the coach's Google
//   Calendar, set coach_user_id + google_event_id + meeting_url, meeting link is
//   the coach's zoom_link (else an auto-created Meet).
//   LEGACY SHARED PATH — no funnel, or a funnel owner with no Google connection:
//   the original single shared-Zoom flow, unchanged (nothing regresses).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const slotStart = typeof body.slot_start === 'string' ? body.slot_start : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''

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

  const answersMap = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers
    : {}) as Record<string, unknown>

  const startMs = new Date(slotStart).getTime()
  if (startMs <= Date.now()) return res.status(400).json({ error: 'slot_start must be in the future' })
  const startIso = new Date(startMs).toISOString()

  // Optional session — attach the member if one is logged in; anonymous is fine.
  let userId: string | null = null
  const token = getSessionFromRequest(req as any)
  if (token) {
    const payload = await verifySessionToken(token)
    if (payload) userId = payload.userId
  }

  // Resolve the funnel + owner + Google connection to choose the path.
  let funnelRow: Record<string, any> | null = null
  let conn: ValidToken | null = null
  if (funnelId) {
    funnelRow = await resolveLiveFunnel({ funnelId })
    if (funnelRow) conn = await getValidAccessToken(funnelRow.user_id as string)
  }

  try {
    if (funnelRow && conn) {
      return await bookGooglePath(res, { funnelRow, owner: funnelRow.user_id as string, conn, startMs, startIso, name, email, answersMap, userId })
    }
    return await bookLegacyPath(res, { funnelRow, startMs, startIso, name, email, answersMap, userId })
  } catch (err) {
    console.error('[calendar/book] POST', err)
    return res.status(500).json({ error: 'Failed to book' })
  }
}

// ---- helpers ----------------------------------------------------------------

function utcLabel(startIso: string): string {
  return (
    new Date(startIso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' (UTC)'
  )
}

// Log the server-side 'booked' funnel event, attributing to the lead by matching
// email on that funnel (a client-supplied lead_id is never trusted). Best-effort.
async function logFunnelBooked(funnelId: string, email: string): Promise<void> {
  try {
    const { data: lead } = await supabase
      .from('funnel_leads')
      .select('id')
      .eq('funnel_id', funnelId)
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    await supabase.from('funnel_events').insert({ funnel_id: funnelId, lead_id: lead?.id ?? null, event_type: 'booked' })
  } catch (err) {
    console.error('[calendar/book] funnel booked event', err)
  }
}

function eventDescription(name: string, email: string, answers: ValidatedAnswer[]): string {
  const lines = ['New booking from your funnel.', `Name: ${name}`, `Email: ${email}`]
  const filled = answers.filter((a) => a.answer)
  if (filled.length) {
    lines.push('')
    for (const a of filled) lines.push(`${a.label}: ${a.answer}`)
  }
  return lines.join('\n')
}

// ---- funnel Google path -----------------------------------------------------

async function bookGooglePath(
  res: VercelResponse,
  ctx: {
    funnelRow: Record<string, any>
    owner: string
    conn: ValidToken
    startMs: number
    startIso: string
    name: string
    email: string
    answersMap: Record<string, unknown>
    userId: string | null
  }
): Promise<VercelResponse> {
  const { funnelRow, owner, conn, startMs, startIso, name, email, answersMap, userId } = ctx

  const settings = await loadUserAvailability(owner)
  const endIso = new Date(startMs + settings.slot_minutes * 60_000).toISOString()

  // Validate answers against THIS funnel's questions.
  const questions = await loadFunnelBookingQuestions(funnelRow.id as string)
  const av = validateBookingAnswers(questions, answersMap)
  if (!av.ok) return res.status(400).json({ error: av.error, question: av.question })

  // Parity: the slot must be genuinely open per the same engine the page showed.
  if (!(await isSlotOpen(owner, startIso))) return res.status(409).json({ error: 'slot_taken' })

  // Reserve first (per-coach unique index is the concurrency backstop), then
  // create the event — release the reservation if the event create fails.
  const { data: reserved, error: reserveErr } = await supabase
    .from('bookings')
    .insert({
      user_id: userId,
      coach_user_id: owner,
      name,
      email,
      start_time: startIso,
      end_time: endIso,
      status: 'active',
      custom_answers: av.answers,
    })
    .select('id')
    .single()

  if (reserveErr) {
    if ((reserveErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'slot_taken' })
    throw reserveErr
  }

  // Meeting room: the coach's configured zoom_link, else an auto-created Meet.
  const biz = await loadBusinessSettings(owner)
  const zoomLink = biz.zoom_link

  let event: { eventId: string; htmlLink: string | null; meetUrl: string | null } | null
  try {
    event = await createCalendarEvent(owner, {
      summary: `MTM call with ${name}`,
      description: eventDescription(name, email, av.answers),
      startIso,
      endIso,
      attendeeEmails: [email],
      timezone: settings.working_hours.timezone,
      location: zoomLink || undefined,
      addMeet: !zoomLink,
    })
  } catch (evErr) {
    await supabase.from('bookings').delete().eq('id', reserved.id)
    console.error('[calendar/book] google event create failed — reservation released', evErr)
    return res.status(502).json({ error: 'Failed to create calendar event' })
  }
  if (!event) {
    await supabase.from('bookings').delete().eq('id', reserved.id)
    return res.status(502).json({ error: 'Failed to create calendar event' })
  }

  const meetingUrl = zoomLink || event.meetUrl || ''
  await supabase.from('bookings').update({ google_event_id: event.eventId, meeting_url: meetingUrl }).eq('id', reserved.id)

  await logFunnelBooked(funnelRow.id as string, email)

  // Confirmation + .ics to the lead (organizer = the coach's connected calendar),
  // and a best-effort notification to the coach. Never fail the booking on email.
  const startLabel = utcLabel(startIso)
  const organizerEmail = conn.calendar_email || process.env.ZOOM_HOST_EMAIL || 'noreply@mail.microtrainingmethod.com'
  const ics = buildBookingIcs({
    uid: `booking-${reserved.id}@microtrainingmethod.com`,
    startUtcISO: startIso,
    endUtcISO: endIso,
    summary: 'Micro-Training Method call',
    description: `Your call is booked. Join here: ${meetingUrl}`,
    joinUrl: meetingUrl,
    organizerEmail,
    attendeeEmail: email,
  })
  await sendBookingConfirmationEmail({ email, name, startLabel, joinUrl: meetingUrl, icsContent: ics })
  await sendCoachBookingNotification({
    coachEmail: conn.calendar_email || '',
    leadName: name,
    leadEmail: email,
    startLabel,
    answers: av.answers,
  })

  return res.status(200).json({ booking_id: reserved.id, join_url: meetingUrl, meeting_url: meetingUrl, start_time: startIso })
}

// ---- legacy shared-Zoom path (unchanged behavior) ---------------------------

async function bookLegacyPath(
  res: VercelResponse,
  ctx: {
    funnelRow: Record<string, any> | null
    startMs: number
    startIso: string
    name: string
    email: string
    answersMap: Record<string, unknown>
    userId: string | null
  }
): Promise<VercelResponse> {
  const { funnelRow, startMs, startIso, name, email, answersMap, userId } = ctx

  if (!isZoomConfigured()) return res.status(503).json({ error: 'calendar_unavailable' })

  const endIso = new Date(startMs + slotMinutes() * 60_000).toISOString()

  // Global custom questions for the shared path.
  const questions = await loadBookingQuestions()
  const av = validateBookingAnswers(questions, answersMap)
  if (!av.ok) return res.status(400).json({ error: av.error, question: av.question })

  // 1) Confirm the slot is genuinely still open per Zoom Scheduler.
  const dayStart = new Date(startMs - 60_000).toISOString()
  const dayEnd = new Date(startMs + slotMinutes() * 60_000 + 60_000).toISOString()
  const slots = await getSchedulerAvailability(dayStart, dayEnd)
  if (!slots.some((s) => new Date(s.start).getTime() === startMs)) {
    return res.status(409).json({ error: 'slot_taken' })
  }

  // 2) Reserve (coach_user_id stays NULL — the shared calendar; the NULLS NOT
  // DISTINCT unique index still prevents two shared bookings at the same time).
  const { data: reserved, error: reserveErr } = await supabase
    .from('bookings')
    .insert({ user_id: userId, name, email, start_time: startIso, end_time: endIso, status: 'active', custom_answers: av.answers })
    .select('id')
    .single()

  if (reserveErr) {
    if ((reserveErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'slot_taken' })
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

  await supabase.from('bookings').update({ zoom_meeting_id: meeting.id, zoom_join_url: meeting.join_url }).eq('id', reserved.id)

  // Funnel attribution when this legacy booking still came from a funnel (owner
  // not Google-connected).
  if (funnelRow) await logFunnelBooked(funnelRow.id as string, email)

  const startLabel = utcLabel(startIso)
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

  return res.status(200).json({ booking_id: reserved.id, join_url: meeting.join_url, start_time: startIso })
}
