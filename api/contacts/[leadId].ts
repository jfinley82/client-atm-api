import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import {
  BookingRow,
  pickBooking,
  buildContact,
  renderAnswers,
  loadOutcomeTimes,
  loadLatestVideo,
} from '../../lib/contacts'

// GET /api/contacts/[leadId] — one contact in full. Powers the lead-detail and
// call-prep surfaces.
//
// { contact, lead, application: [{question, answer}], booking, notes, timeline }
//
// Addressed by lead id ALONE (no funnel in the path) because the contacts list
// is account-level. Ownership is enforced by resolving the lead's funnel and
// checking funnels.user_id — a lead on someone else's funnel 404s exactly like
// one that does not exist.
export const config = { maxDuration: 30 }

const LEAD_COLUMNS =
  'id, funnel_id, email, name, first_name, phone, status, qualification_status, application_status, application_answers, application_submitted_at, opted_in_at, nurture_pivoted, close_amount, notes, source, email_unsubscribed, created_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const leadId = req.query.leadId as string
  if (!leadId) return res.status(400).json({ error: 'leadId required' })

  try {
    const { data: lead } = await supabase.from('funnel_leads').select(LEAD_COLUMNS).eq('id', leadId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Contact not found' })

    // Ownership via the parent funnel. booking_questions supplies the labels the
    // stored answers are keyed by.
    const { data: funnel } = await supabase
      .from('funnels')
      .select('id, user_id, subdomain, problem_solution_label, landing_page, booking_questions')
      .eq('id', (lead as any).funnel_id)
      .maybeSingle()
    if (!funnel || (funnel as any).user_id !== userId) return res.status(404).json({ error: 'Contact not found' })

    const [bookingsRes, notesRes, eventsRes, wonAtByLead, videoByLead] = await Promise.all([
      supabase
        .from('bookings')
        .select('id, funnel_id, email, name, start_time, end_time, attended, attendance_marked_at, status, zoom_join_url, meeting_url, custom_answers, reschedule_count, created_at')
        .eq('funnel_id', (lead as any).funnel_id)
        // ilike, not eq: a booking is taken from a form the lead retypes, so
        // case can drift from the opt-in row. The list endpoint normalizes the
        // same way (lib/contacts.ts bookingKey) — matching exactly here would
        // let the list show a call the detail view then claims does not exist.
        .ilike('email', (lead as any).email),
      supabase
        .from('funnel_lead_notes')
        .select('id, body, created_at, author_user_id')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false }),
      supabase
        .from('funnel_events')
        .select('event_type, created_at, metadata')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false }),
      loadOutcomeTimes([leadId]),
      loadLatestVideo([leadId]),
    ])

    const bookings = (bookingsRes.data || []) as BookingRow[]
    const booking = pickBooking(bookings)
    const now = Date.now()
    const contact = buildContact(lead, booking, funnel as Record<string, any>, wonAtByLead.get(leadId) ?? null, videoByLead.get(leadId) ?? null, now)

    // Milestones the lead row itself records, merged with the logged events, so
    // the timeline is complete even where no event was written (opt-in and
    // application predate parts of the event vocabulary).
    const timeline: { type: string; label: string; at: string }[] = []
    const add = (type: string, label: string, at: unknown) => {
      if (typeof at === 'string' && at) timeline.push({ type, label, at })
    }
    add('created', 'Contact captured', (lead as any).created_at)
    add('opted_in', 'Opted in', (lead as any).opted_in_at)
    if ((lead as any).application_submitted_at) {
      const st = (lead as any).application_status
      add('application', st === 'disqualified' ? 'Application submitted — not a fit' : 'Application submitted', (lead as any).application_submitted_at)
    }
    for (const b of bookings) {
      add('booking', b.status === 'canceled' ? 'Call canceled' : 'Call booked', b.created_at)
      if (b.attended === 'showed') add('attendance', 'Showed for the call', (b as any).attendance_marked_at)
      if (b.attended === 'no_show') add('attendance', 'Did not show', (b as any).attendance_marked_at)
    }
    for (const ev of (eventsRes.data || []) as { event_type: string; created_at: string }[]) {
      if (ev.event_type === 'sold' || ev.event_type === 'closed') add('won', 'Closed', ev.created_at)
    }
    timeline.sort((a, b) => b.at.localeCompare(a.at))

    return res.status(200).json({
      contact,
      lead,
      application: renderAnswers((lead as any).application_answers, (funnel as any).booking_questions),
      booking: booking
        ? {
            id: booking.id,
            start_time: booking.start_time,
            end_time: (booking as any).end_time ?? null,
            // zoom_join_url is the legacy shared-Zoom field; meeting_url is the
            // funnel/Google path's. Either can be the live link.
            join_url: booking.zoom_join_url || booking.meeting_url || null,
            attended: booking.attended,
            attendance_marked_at: (booking as any).attendance_marked_at ?? null,
            status: booking.status,
            answers: renderAnswers(booking.custom_answers, (funnel as any).booking_questions),
          }
        : null,
      notes: notesRes.data || [],
      timeline,
    })
  } catch (err) {
    console.error('[contacts/[leadId]] GET', err)
    return res.status(500).json({ error: 'Failed to load contact' })
  }
}
