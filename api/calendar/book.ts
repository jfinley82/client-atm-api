import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { isZoomConfigured, createZoomMeeting, slotMinutes } from '../../lib/zoom'
import { isSchedulerSlotOpen } from '../../lib/schedulerSlots'
import { buildBookingIcs, FALLBACK_ORGANIZER_EMAIL } from '../../lib/ics'
import { resolveBookingBrand, sendBookingConfirmationEmail, sendCoachBookingNotification } from '../../lib/email'
import { validateBookingAnswers, bookingQuestionErrorMessage, resolveBookingType, resolveBookingRequirements, normalizeLeadPhone, ValidatedAnswer } from '../../lib/bookingQuestions'
import { bookingTimeLabel, normalizeTimeZone } from '../../lib/bookingTimezone'
import { checkGate } from '../../lib/applicationGate'
import { resolveLiveFunnel } from '../../lib/funnels'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { isSlotOpen } from '../../lib/funnelAvailability'
import { getValidAccessToken, createCalendarEvent, deleteCalendarEvent, ValidToken } from '../../lib/googleCalendar'
import { loadBusinessSettings } from '../../lib/businessSettings'
import { cancelLeadOutreach, scheduleBookingReminders } from '../../lib/funnelNurture'
import { buildBookingManageUrl } from '../../lib/bookingManage'
import { resolveBookingSlug } from '../../lib/bookingPage'
import { resolveMeetingRoom } from '../../lib/meetingRoom'

// POST /api/calendar/book
// Body: { slot_start, first_name, last_name, email, answers?, funnel_id? }
//   - answers is a MAP keyed by question id: { [questionId]: value }.
//
// EVERY BOOKING HAS A HOST, and the host decides everything.
//
//   COACH PATH — a booking_slug or a funnel_id. The host is that coach. Slots
//   are validated with isSlotOpen against the coach's own availability, the same
//   engine their page listed from, and the room comes from
//   resolveMeetingRoom(host). Whether the coach has Google connected changes
//   only whether a calendar event is also created; it does not change who hosts,
//   and it does not change which path runs.
//
//   MTM PATH — no slug and no funnel: MTM's own discovery call. The host is the
//   Zoom-integrated account by construction, so the room is a real Zoom meeting
//   and the slot is validated against MTM's Zoom scheduler, which is the list
//   that page renders from.
//
// The path used to be chosen by whether the coach had Google connected, so a
// coach without it had their leads booked into MTM's shared Zoom — Jamaul's
// personal room. Host identity does not depend on integrations.
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

  // TOP-LEVEL, not an answers-map key. The answers map is validated against
  // admin-defined questions and neither of these is one — a type sent inside
  // `answers` is never read (see BOOKING_TYPE_ANSWER_ID), and a timezone has no
  // business being an answer at all.
  const bookingTypeRaw = body.booking_type
  // Optional. Absent or invalid falls back to the UTC rendering that shipped
  // before, so nothing regresses for a caller that does not send it.
  const timezone = normalizeTimeZone(body.timezone)

  // CONTACT DETAIL, not a qualifying answer — it never lands in custom_answers.
  // Validated loosely: people type spaces, dashes, brackets and country codes,
  // and refusing a booking over formatting costs more than an untidy string.
  const phoneCheck = normalizeLeadPhone(body.phone)
  if (!phoneCheck.ok) {
    return res.status(400).json({ error: 'phone_invalid', message: bookingQuestionErrorMessage('phone_invalid', '') })
  }
  const leadPhone = phoneCheck.phone

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

  // A coach's own booking page identifies its owner by SLUG — the only public
  // identifier a coach has. It is not a funnel: no application gate, no funnel
  // questions, no funnel attribution, and no booking_type, since that is a
  // global MTM setting and the argument that keeps it off funnel bookings keeps
  // it off this one too.
  const bookingSlug = typeof body.booking_slug === 'string' ? body.booking_slug.trim() : ''

  // Resolve the owner + Google connection to choose the path.
  let funnelRow: Record<string, any> | null = null
  let conn: ValidToken | null = null
  let slugOwner: string | null = null
  if (bookingSlug) {
    const pageOwner = await resolveBookingSlug(bookingSlug)
    if (!pageOwner) return res.status(404).json({ error: 'not_found' })
    slugOwner = pageOwner.userId
    conn = await getValidAccessToken(slugOwner)
  } else if (funnelId) {
    funnelRow = await resolveLiveFunnel({ funnelId })
    if (funnelRow) conn = await getValidAccessToken(funnelRow.user_id as string)
  }

  try {
    // ONE coach implementation, whether the owner came from a funnel or a slug.
    // A second copy for the coach page is how the two would answer differently
    // for the same coach within a month.
    // A FUNNEL BOOKING IS HOSTED BY ITS COACH, with or without Google. Requiring
    // `conn` here is what sent charge-demo's leads to Jamaul's Zoom room.
    const coachOwner = slugOwner || (funnelRow ? (funnelRow.user_id as string) : null)
    if (coachOwner) {
      return await bookCoachPath(res, { funnelRow, owner: coachOwner, conn, startMs, startIso, name, email, answersMap, userId, timezone, leadPhone })
    }
    return await bookMtmPath(res, { startMs, startIso, name, email, answersMap, userId, timezone, leadPhone, bookingTypeRaw })
  } catch (err) {
    console.error('[calendar/book] POST', err)
    return res.status(500).json({ error: 'Failed to book' })
  }
}

// ---- helpers ----------------------------------------------------------------

// Log the server-side 'booked' funnel event, attributing to the lead by matching
// email on that funnel (a client-supplied lead_id is never trusted). Best-effort.
// Returns the resolved lead id (or null) so the caller can attribute the
// confirmation email's opens/clicks to the same lead (Phase 5a).
async function logFunnelBooked(funnelId: string, email: string): Promise<string | null> {
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
    return (lead?.id as string) ?? null
  } catch (err) {
    console.error('[calendar/book] funnel booked event', err)
    return null
  }
}

// A lead the application gate turned away must NEVER become a booking row, so
// this returns BEFORE the reservation insert on both paths — no calendar event,
// no Zoom meeting, no confirmation email, nothing to cancel afterwards.
//
// It is a real enforcement point, not a mirror of the page: the two-step booking
// page decides the same thing client-side for the screen, but a POST straight to
// this endpoint skips that entirely. Both call the same checkGate().
//
// 403 rather than 400: the submission is well-formed, it is the outcome that
// denies it. The page shows the funnel's own disqualify screen from these fields.
function disqualified(
  res: VercelResponse,
  gate: { action: string; message: string; redirect_url: string | null }
): VercelResponse {
  return res
    .status(403)
    .json({ error: 'disqualified', action: gate.action, message: gate.message, redirect_url: gate.redirect_url })
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

// ---- coach path (a funnel's owner, or a coach's own booking page) -----------
//
// Named for the OWNER rather than for Google, because that is what it actually
// keys on. It serves a funnel booking whose owner is Google-connected and a
// booking made through the coach's own slug, which may or may not be. Both set
// coach_user_id; neither uses MTM's shared Zoom account.

async function bookCoachPath(
  res: VercelResponse,
  ctx: {
    // NULL for a booking made through the coach's own page: it has an owner but
    // no funnel behind it.
    funnelRow: Record<string, any> | null
    owner: string
    // NULL when the coach has no Google connection. They are still bookable if
    // they have configured a meeting room of their own.
    conn: ValidToken | null
    startMs: number
    startIso: string
    name: string
    email: string
    answersMap: Record<string, unknown>
    userId: string | null
    timezone: string | null
    leadPhone: string | null
  }
): Promise<VercelResponse> {
  const { funnelRow, owner, conn, startMs, startIso, name, email, answersMap, userId, timezone, leadPhone } = ctx

  const settings = await loadUserAvailability(owner)
  const endIso = new Date(startMs + settings.slot_minutes * 60_000).toISOString()

  // COACH-LEVEL STATE IS ANSWERED FIRST, before anything about the form.
  //
  // isSlotOpen has two reasons to say no and the caller can only report one:
  // until availability gating it was false only for "that slot is taken", so
  // mapping false -> slot_taken was safe. It is not any more, and the frontend
  // retries a 409 by refreshing slots — which for an unconfigured coach returns
  // an empty list, so the page would ask someone to pick another time from
  // nothing, forever.
  //
  // It also has to outrank the phone and question checks below. Telling a
  // visitor to fix their phone number on a page that cannot take bookings at all
  // is the same misleading-message problem one level down: they would correct
  // the field and be refused again for the real reason, which was never shown.
  //
  // coach_not_bookable matches the code the no-meeting-room branch already uses,
  // so the page has one state to render rather than two spellings of it.
  if (!settings.configured) return res.status(503).json({ error: 'coach_not_bookable' })

  // ONE resolution for what the form asks. Validated against the SAME set the
  // page renders from, so a lead is never rejected for a field the form never
  // showed them. The page renders from exactly this,
  // so the asterisk it shows and the refusal below cannot disagree — a coach
  // flipping the phone toggle must not leave leads refused for a field the form
  // called optional.
  const { questions, phoneRequired } = await resolveBookingRequirements({ funnelRow, coachUserId: owner })
  if (phoneRequired && !leadPhone) {
    return res.status(400).json({ error: 'phone_required', field: 'phone', message: bookingQuestionErrorMessage('phone_required', '') })
  }
  const av = validateBookingAnswers(questions, answersMap)
  if (!av.ok) {
    return res
      .status(400)
      .json({ error: av.error, question: av.question, message: bookingQuestionErrorMessage(av.error, av.question) })
  }

  // The application gate belongs to a funnel. A coach handing out their own link
  // has already decided this person may book.
  if (funnelRow) {
    const gate = checkGate(funnelRow, questions, answersMap)
    if (!gate.qualified) return disqualified(res, gate)
  }

  // Parity: the slot must be genuinely open per the same engine the page showed.
  // Reaching here, false means exactly one thing again.
  if (!(await isSlotOpen(owner, startIso))) return res.status(409).json({ error: 'slot_taken' })

  // Reserve first (per-coach unique index is the concurrency backstop), then
  // create the event — release the reservation if the event create fails.
  const { data: reserved, error: reserveErr } = await supabase
    .from('bookings')
    .insert({
      user_id: userId,
      // Set on BOTH kinds of coach booking. It is null on every row in the
      // database today, which is what made the manage link dead for all of them
      // — a booking through a coach's own page has an unambiguous owner.
      coach_user_id: owner,
      // Which funnel this call came from — the Upcoming Calls panel filters on
      // it. Absent for a coach-page booking, which came from no funnel.
      ...(funnelRow ? { funnel_id: funnelRow.id as string } : {}),
      name,
      email,
      start_time: startIso,
      end_time: endIso,
      status: 'active',
      custom_answers: av.answers,
      timezone,
      lead_phone: leadPhone,
    })
    .select('id')
    .single()

  if (reserveErr) {
    if ((reserveErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'slot_taken' })
    throw reserveErr
  }

  // ONE RULE for where the call happens, resolved from the HOST — lib/meetingRoom.ts.
  // Not from which path we are on, and not from which integrations the host
  // happens to have connected.
  const room = await resolveMeetingRoom(owner, !!conn)
  if (room.kind === 'none') {
    await supabase.from('bookings').delete().eq('id', reserved.id)
    console.error('[calendar/book] host has no room: not the Zoom account, no zoom_link, no Google', owner)
    return res.status(503).json({ error: 'coach_not_bookable' })
  }

  // Rule 1: this host IS the Zoom-integrated account. Reached by Jamaul's own
  // funnel or booking page and by nobody else, because the rule keys on identity
  // rather than on a role.
  let zoomMeeting: { id: string; join_url: string } | null = null
  if (room.kind === 'zoom_integration') {
    try {
      zoomMeeting = await createZoomMeeting(`MTM call with ${name}`, startIso)
    } catch (zoomErr) {
      await supabase.from('bookings').delete().eq('id', reserved.id)
      console.error('[calendar/book] zoom create failed — reservation released', zoomErr)
      return res.status(502).json({ error: 'Failed to create meeting' })
    }
    await supabase
      .from('bookings')
      .update({ zoom_meeting_id: zoomMeeting.id, zoom_join_url: zoomMeeting.join_url })
      .eq('id', reserved.id)
  }

  const zoomLink = room.kind === 'zoom_link' ? room.url : ''

  // A calendar event whenever Google is connected, whichever room the call is
  // in — the coach still wants it on their calendar. addMeet only when the Meet
  // IS the room.
  let event: { eventId: string; htmlLink: string | null; meetUrl: string | null } | null = null
  try {
    if (conn) event = await createCalendarEvent(owner, {
      summary: `MTM call with ${name}`,
      description: eventDescription(name, email, av.answers),
      startIso,
      endIso,
      attendeeEmails: [email],
      timezone: settings.working_hours.timezone,
      location: zoomLink || zoomMeeting?.join_url || undefined,
      addMeet: room.kind === 'google_meet',
    })
  } catch (evErr) {
    await supabase.from('bookings').delete().eq('id', reserved.id)
    console.error('[calendar/book] google event create failed — reservation released', evErr)
    return res.status(502).json({ error: 'Failed to create calendar event' })
  }
  if (conn && !event) {
    await supabase.from('bookings').delete().eq('id', reserved.id)
    return res.status(502).json({ error: 'Failed to create calendar event' })
  }

  // A Meet was requested (no zoom_link) but Google returned no conference link —
  // don't save a booking with an empty confirmation link. Treat it like an
  // event-create failure: delete the orphan event and release the reservation.
  const meetingUrl = zoomMeeting?.join_url || zoomLink || event?.meetUrl || ''
  if (!meetingUrl) {
    if (event) await deleteCalendarEvent(owner, event.eventId).catch(() => {})
    await supabase.from('bookings').delete().eq('id', reserved.id)
    console.error('[calendar/book] google event created without a meeting link — released')
    return res.status(502).json({ error: 'Failed to create meeting link' })
  }
  if (event) {
    await supabase.from('bookings').update({ google_event_id: event.eventId, meeting_url: meetingUrl }).eq('id', reserved.id)
  }

  // Funnel attribution only exists when a funnel does.
  const leadId = funnelRow ? await logFunnelBooked(funnelRow.id as string, email) : null

  // Confirmation + .ics to the lead (organizer = the coach's connected calendar),
  // and a best-effort notification to the coach. Never fail the booking on email.
  const startLabel = bookingTimeLabel(startIso, timezone)
  // NOT ZOOM_HOST_EMAIL. That is the Zoom API's idea of the host and must be a
  // real user in the Zoom account; putting it here would print that address on
  // the calendar invite of every client who books.
  const organizerEmail = conn?.calendar_email || FALLBACK_ORGANIZER_EMAIL
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
  // Lead-side manage link (Phase 3b follow-up): reschedule/cancel, on the funnel
  // domain so /api/ reaches the real function rather than the renderer.
  const manageUrl = buildBookingManageUrl(reserved.id as string, (funnelRow?.subdomain as string) || null)

  await sendBookingConfirmationEmail({
    email,
    name,
    startLabel,
    joinUrl: meetingUrl,
    icsContent: ics,
    coachUserId: owner,
    manageUrl,
    bookingId: reserved.id as string,
    ...(funnelRow ? { funnelId: funnelRow.id as string, leadId } : {}),
  })
  // Sent for a coach-page booking too. The preference is keyed by USER, not by
  // funnel — a coach who gets a booking on their own page and is never told is
  // worse off than one who gets a plainer email.
  await sendCoachBookingNotification({
    coachUserId: owner,
    funnel: funnelRow,
    bookingId: reserved.id as string,
    leadId,
    leadName: name,
    leadEmail: email,
    leadPhone,
    startIso,
    answers: av.answers,
  })

  // Nurture suppression (Phase 5b): a booked lead exits the sequence — cancel any
  // still-scheduled nurture/book-a-call sends — and gets 24h/1h call reminders.
  if (leadId) await cancelLeadOutreach(leadId)
  // Reminders are scheduled for EVERY booking, lead or not — the cadence is a
  // property of the call, not of whether we matched a funnel lead to it.
  await scheduleBookingReminders({
    brand: await resolveBookingBrand(owner),
    funnelId: funnelRow ? (funnelRow.id as string) : null,
    leadId,
    email,
    startIso,
    joinUrl: meetingUrl,
    bookingId: reserved.id as string,
    manageUrl,
    timezone,
  })

  return res.status(200).json({ booking_id: reserved.id, join_url: meetingUrl, meeting_url: meetingUrl, start_time: startIso })
}

// ---- MTM's own discovery call -----------------------------------------------
//
// No slug and no funnel. The host is the Zoom-integrated account by
// construction, so the room is a real Zoom meeting and the slot is validated
// against MTM's Zoom scheduler — the same list GET /api/calendar/availability
// renders.
//
// IT NO LONGER TAKES A FUNNEL. A funnel whose owner had no Google used to fall
// through to here and be booked into MTM's shared Zoom; that routing is gone, so
// every funnel branch in this function was dead. Leaving them would have
// described a path that no longer happens — the exact failure CLAUDE.md now
// records.
async function bookMtmPath(
  res: VercelResponse,
  ctx: {
    startMs: number
    startIso: string
    name: string
    email: string
    answersMap: Record<string, unknown>
    userId: string | null
    timezone: string | null
    leadPhone: string | null
    bookingTypeRaw: unknown
  }
): Promise<VercelResponse> {
  const { startMs, startIso, name, email, answersMap, userId, timezone, leadPhone, bookingTypeRaw } = ctx

  if (!isZoomConfigured()) return res.status(503).json({ error: 'calendar_unavailable' })

  // Length comes from the same Zoom grid the slot was listed on.
  const endIso = new Date(startMs + slotMinutes() * 60_000).toISOString()

  // Global custom questions for the shared path.
  // MTM's own questions and phone rule — the global set, which is what this page
  // is. A funnel answers from its own settings, over on the coach path.
  const { questions, phoneRequired } = await resolveBookingRequirements({})
  if (phoneRequired && !leadPhone) {
    return res.status(400).json({ error: 'phone_required', field: 'phone', message: bookingQuestionErrorMessage('phone_required', '') })
  }
  const av = validateBookingAnswers(questions, answersMap)
  if (!av.ok) {
    return res
      .status(400)
      .json({ error: av.error, question: av.question, message: bookingQuestionErrorMessage(av.error, av.question) })
  }

  // BOOKING TYPE APPLIES ONLY TO A FUNNEL-LESS BOOKING, and that is a decision
  // rather than a consequence of where the code sits.
  //
  // booking_types is a GLOBAL app_settings key. A funnel answers from its own
  // settings and nothing else — that rule is why funnelBookingQuestions exists
  // and why falling back to the global question set hard-blocked bookings on
  // charge-demo. Letting a global type list attach itself to a funnel booking
  // would reintroduce exactly that shape. So a funnel booking carries no type,
  // on EITHER path: bookCoachPath always has a funnel when it is reached from one, and this path skips it
  // whenever one is in play. A stray value on a funnel booking is ignored, not
  // rejected, for the same reason an unconfigured list ignores one.
  //
  // Consequence worth stating: eventDescription builds the Google invite body
  // from these answers, so the concern about the type appearing there does not
  // arise — that path never has a type to show. If funnel-level types are wanted
  // later they belong on the funnel row, beside its own booking_questions.
  // The booking type is a GLOBAL MTM setting, so this page is the only place it
  // applies — a coach's page and a funnel both answer from their own settings.
  let answers = av.answers
  const typed = await resolveBookingType(bookingTypeRaw)
  if (!typed.ok) return res.status(400).json({ error: typed.error, message: typed.message })
  // FIRST in the list. It is the framing question and reads wrong underneath
  // "what's your current monthly revenue".
  if (typed.entry) answers = [typed.entry, ...answers]

  // THE THIRD ROUTE, and the one coach_not_bookable did not reach.
  //
  // A funnel whose owner has no Google connection lands here, not in
  // bookCoachPath — coachOwner requires `conn`. That is the worst case to leave
  // uncovered: a coach who never connected Google is the coach most likely never
  // to have set their hours either, so an unconfigured coach's funnel was still
  // answering 409 slot_taken for a slot with nothing booked in it.
  //
  // Asked before either slot check, for the same reason it outranks the form
  // checks above: a page that cannot take bookings must say so rather than send
  // the visitor into a retry loop against an empty list.
  // 1) Confirm the slot is genuinely still open.
  //
  // TWO ENGINES, because two different things have to be free, and the comment
  // that used to sit here was stale. It said the page "calls
  // GET /api/calendar/availability, which now shares this exact function" —
  // true when this path served only MTM's own funnel-less page, and false ever
  // since native-calendar funnels started routing through it. A FUNNEL page
  // calls GET /api/funnel/availability, which lists from computeOpenSlots
  // against the COACH's working hours, so validating only against MTM's Zoom
  // scheduler meant list and accept answered from different sources.
  //
  //   isSlotOpen(coach)     — the engine that produced the list the lead saw.
  //   isSchedulerSlotOpen   — MTM's shared Zoom host, which physically holds the
  //                           meeting this path creates and is shared across
  //                           every coach on it.
  //
  // The historical objection to checking the coach's engine here was that it
  // "yields nothing for a coach who never configured custom availability" and so
  // rejected every valid pick. That case is now refused above, by name, before
  // reaching this line — which is what makes the check safe to add.
  if (!(await isSchedulerSlotOpen(startIso))) {
    return res.status(409).json({ error: 'slot_taken' })
  }

  // 2) Reserve.
  const { data: reserved, error: reserveErr } = await supabase
    .from('bookings')
    .insert({
      user_id: userId,
      name,
      email,
      start_time: startIso,
      end_time: endIso,
      status: 'active',
      custom_answers: answers,
      timezone,
      lead_phone: leadPhone,
      // funnel_id only. coach_user_id stays NULL on purpose: this path books the
      // ONE shared Zoom host, so the NULLS NOT DISTINCT uniqueness backstop must
      // keep these globally unique per start_time. Scoping them per coach (tried
      // in #104) would let two coaches double-book the same shared host.
    })
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

  // No funnel, so no funnel attribution and no lead to match against.
  const leadId: string | null = null

  const startLabel = bookingTimeLabel(startIso, timezone)
  const ics = buildBookingIcs({
    uid: `booking-${reserved.id}@microtrainingmethod.com`,
    startUtcISO: startIso,
    endUtcISO: endIso,
    summary: 'Micro-Training Method call',
    description: `Your call is booked. Join here: ${meeting.join_url}`,
    joinUrl: meeting.join_url,
    // MTM's own page has no coach and therefore no connected calendar address.
    organizerEmail: FALLBACK_ORGANIZER_EMAIL,
    attendeeEmail: email,
  })
  await sendBookingConfirmationEmail({
    email,
    name,
    startLabel,
    joinUrl: meeting.join_url,
    icsContent: ics,
    // Five reminders with no way out is how a cancellation becomes a no-show, so
    // the manage link rides on the confirmation for public bookings too.
    manageUrl: buildBookingManageUrl(reserved.id as string, null),
    bookingId: reserved.id as string,
  })

  // No coach notification: this is MTM's own call, so there is nobody else to
  // tell. A coach-page or funnel booking is notified on the coach path, from the
  // coach's own per-user preference.

  // The full five-touch cadence, wearing MTM's brand, recording send rows with a
  // null funnel_id (migration 089).
  await scheduleBookingReminders({
    brand: await resolveBookingBrand(null),
    funnelId: null,
    leadId,
    email,
    startIso,
    joinUrl: meeting.join_url,
    bookingId: reserved.id as string,
    manageUrl: buildBookingManageUrl(reserved.id as string, null),
    timezone,
  })

  return res.status(200).json({ booking_id: reserved.id, join_url: meeting.join_url, start_time: startIso })
}
