import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { WON_STATUSES, LOST_STATUS, bookingKey, funnelDisplayName } from '../../lib/contacts'

// GET /api/calendar — the coach's whole calendar surface, across ALL their
// funnels. Three arrays, each answering a different question:
//
//   needs_outcome       past calls with nothing recorded — the close-out loop
//   approved_not_booked qualified applicants who never booked — the recovery list
//   agenda              upcoming calls, ascending
//
// ?month=YYYY-MM switches `agenda` to every call in that month (Month view and
// the mini-month dots) instead of upcoming-only. The two work queues are NOT
// month-scoped: an unclosed call from two months ago is still owed an outcome,
// and hiding it because the coach paged to a different month would defeat the
// loop this endpoint exists to drive.
//
// Ownership is resolved ONCE (funnels.user_id = caller) and every query is
// scoped to that id set — RLS is off by design here (API-layer auth), so this
// scoping IS the access control. Same shape of guarantee as portfolio.ts.
//
// The upcoming-calls derivation is portfolio.ts's: bookings with status='active'
// and start_time >= now, ascending. Canceled bookings never appear anywhere here.
export const config = { maxDuration: 30 }

const AGENDA_LIMIT = 200
const QUEUE_LIMIT = 200

// bookings has no lead_id — the link is (funnel_id, lower(email)), the same join
// lib/contacts.ts uses. Every row that needs a lead_id resolves through this.
const LEAD_COLUMNS = 'id, funnel_id, email, name, first_name, status, application_status, application_submitted_at'
const BOOKING_COLUMNS = 'id, funnel_id, email, name, start_time, end_time, attended, status, zoom_join_url, meeting_url'

// A lead whose deal is already decided is off both work queues: a closed or
// lost deal is not owed a call outcome and is not a recovery target.
const TERMINAL = new Set<string>([...WON_STATUSES, LOST_STATUS])

// The gate writes application_status ∈ ('applied'|'qualified'|'disqualified')
// — see api/funnel/application.ts and the funnel_leads_application_status_check
// constraint. There is no 'approved' value in the schema; 'qualified' IS the
// approved state. qualification_status is the older parallel column, also
// carrying 'qualified', so both are accepted.
const APPROVED = 'qualified'

type BookingRow = {
  id: string
  funnel_id: string | null
  email: string
  name: string | null
  start_time: string | null
  end_time: string | null
  attended: string | null
  status: string | null
  zoom_join_url: string | null
  meeting_url: string | null
}

type LeadRow = {
  id: string
  funnel_id: string
  email: string
  name: string | null
  first_name: string | null
  status: string | null
  application_status: string | null
  application_submitted_at: string | null
}

// YYYY-MM -> [startISO, endISO) in UTC.
//
// UTC, not the coach's zone: bookings.start_time is a timestamptz and the
// boundary case (a call in the first/last hours of a month for a coach far from
// UTC) can land it in the adjacent month's window. The response echoes the
// coach's `timezone` so the frontend renders in it and can widen its own fetch
// if a boundary call matters.
function monthWindow(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return null
  const start = new Date(Date.UTC(year, mon - 1, 1))
  const end = new Date(Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round(ms / 60000)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const monthParam = typeof req.query.month === 'string' ? req.query.month.trim() : ''
  const window = monthParam ? monthWindow(monthParam) : null
  if (monthParam && !window) {
    return res.status(400).json({ error: 'invalid_field', field: 'month', message: 'expected YYYY-MM' })
  }

  try {
    const [{ data: funnels, error: funnelErr }, availability] = await Promise.all([
      supabase.from('funnels').select('id, subdomain, problem_solution_label, landing_page').eq('user_id', userId),
      loadUserAvailability(userId),
    ])
    if (funnelErr) throw funnelErr

    const owned = (funnels || []) as Record<string, any>[]
    const byFunnel = new Map(owned.map((f) => [f.id as string, f]))
    const funnelIds = owned.map((f) => f.id as string)
    const timezone = availability.working_hours.timezone || 'UTC'

    if (!funnelIds.length) {
      return res.status(200).json({
        timezone,
        month: monthParam || null,
        needs_outcome: [],
        approved_not_booked: [],
        agenda: [],
      })
    }

    const nowIso = new Date().toISOString()

    // One booking pull serves all three arrays. Filtering per-array in SQL would
    // mean three round trips over the same rows for no gain at this size, and
    // needs_outcome must span all time regardless of the month window anyway.
    const [bookingsRes, leadsRes] = await Promise.all([
      supabase
        .from('bookings')
        .select(BOOKING_COLUMNS)
        .in('funnel_id', funnelIds)
        .eq('status', 'active')
        .order('start_time', { ascending: true }),
      supabase.from('funnel_leads').select(LEAD_COLUMNS).in('funnel_id', funnelIds),
    ])
    if (bookingsRes.error) throw bookingsRes.error
    if (leadsRes.error) throw leadsRes.error

    const bookings = (bookingsRes.data || []) as BookingRow[]
    const leads = (leadsRes.data || []) as LeadRow[]

    const leadByKey = new Map<string, LeadRow>()
    for (const l of leads) {
      const key = bookingKey(l.funnel_id, l.email)
      // Newest wins on a duplicate email within one funnel — the same "most
      // recent lead for this email" rule api/calendar/book.ts applies when it
      // attributes a booking.
      if (!leadByKey.has(key)) leadByKey.set(key, l)
    }
    const bookedLeadKeys = new Set(bookings.map((b) => bookingKey(b.funnel_id, b.email)))

    // name falls back to email when null. Lead name first (what the coach knows
    // them as), then the booking form's name, then the address.
    const displayName = (lead: LeadRow | undefined, booking: BookingRow | null, email: string): string => {
      for (const v of [lead?.name, lead?.first_name, booking?.name]) {
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return email
    }

    const shape = (b: BookingRow) => {
      const key = bookingKey(b.funnel_id, b.email)
      const lead = leadByKey.get(key)
      const funnel = byFunnel.get(b.funnel_id as string)
      return {
        booking_id: b.id,
        lead_id: lead?.id ?? null,
        name: displayName(lead, b, b.email),
        email: b.email,
        funnel_id: b.funnel_id,
        funnel_name: funnelDisplayName(funnel),
        start_time: b.start_time,
        end_time: b.end_time,
      }
    }

    // ---- needs_outcome ----------------------------------------------------
    // A past call still owed a DEAL outcome. What clears it is the deal being
    // decided, never the mere presence of an attendance mark:
    //
    //   won / lost        -> cleared. The lead's status is the record of the
    //                        decision. (Recording one leaves bookings.attended
    //                        alone by design, so keying off attendance here
    //                        would leave closed calls in the loop forever.)
    //   no_show           -> cleared. The call never happened, so there is no
    //                        deal outcome to record; the lead goes back to
    //                        nurture instead.
    //   showed, undecided -> STILL LISTED. Marking attendance is not recording
    //                        an outcome, and a call the lead showed up to with
    //                        no win or loss against it is the single most
    //                        important row in this list.
    //   unmarked, undecided -> still listed.
    //
    // Deliberately NOT `attended is not null`: that conflates attendance with
    // outcome and would hide exactly the calls most in need of closing out.
    const needs_outcome = bookings
      .filter((b) => {
        if (!b.start_time) return false
        if (new Date(b.start_time).getTime() >= Date.now()) return false
        if (b.attended === 'no_show') return false
        const lead = leadByKey.get(bookingKey(b.funnel_id, b.email))
        return !TERMINAL.has(String(lead?.status ?? ''))
      })
      // Most overdue first — the oldest unclosed call is the most urgent.
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
      .slice(0, QUEUE_LIMIT)
      .map(shape)

    // ---- approved_not_booked ----------------------------------------------
    const approved_not_booked = leads
      .filter((l) => {
        if (l.application_status !== APPROVED) return false
        if (TERMINAL.has(String(l.status ?? ''))) return false
        return !bookedLeadKeys.has(bookingKey(l.funnel_id, l.email))
      })
      .sort((a, b) => String(b.application_submitted_at || '').localeCompare(String(a.application_submitted_at || '')))
      .slice(0, QUEUE_LIMIT)
      .map((l) => ({
        lead_id: l.id,
        name: displayName(l, null, l.email),
        email: l.email,
        funnel_id: l.funnel_id,
        funnel_name: funnelDisplayName(byFunnel.get(l.funnel_id)),
        // funnel_leads has no approved_at column. The gate decides qualified vs
        // disqualified AT submission, so the submission timestamp IS when they
        // were approved.
        approved_at: l.application_submitted_at,
      }))

    // ---- agenda ------------------------------------------------------------
    // Default: upcoming only. With ?month: every call in that month, past ones
    // included, since a month view that hid the first half of the month would
    // be wrong.
    const agenda = bookings
      .filter((b) => {
        if (!b.start_time) return false
        if (window) return b.start_time >= window.start && b.start_time < window.end
        return b.start_time >= nowIso
      })
      .slice(0, AGENDA_LIMIT)
      .map((b) => ({
        ...shape(b),
        duration_minutes: durationMinutes(b.start_time, b.end_time),
        // zoom_join_url is the legacy shared-Zoom field; meeting_url is what the
        // funnel/Google path writes. Either can be the live link, so fall back
        // rather than reporting null for a call that has one.
        zoom_join_url: b.zoom_join_url || b.meeting_url || null,
      }))

    return res.status(200).json({
      // The coach's configured zone (user_availability.working_hours.timezone).
      // Month windows below are computed in UTC — this is what the frontend
      // should render in.
      timezone,
      month: monthParam || null,
      needs_outcome,
      approved_not_booked,
      agenda,
    })
  } catch (err) {
    console.error('[calendar] GET', err)
    return res.status(500).json({ error: 'Failed to load calendar' })
  }
}
