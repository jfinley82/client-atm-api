import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { WON_STATUSES, LOST_STATUS, bookingKey, funnelDisplayName } from '../../lib/contacts'
import { loadOwnedActiveBookings } from '../../lib/coachBookings'

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
// Ownership is TWO facts, not one, and every query is scoped to one of them —
// RLS is off by design here (API-layer auth), so this scoping IS the access
// control. Same shape of guarantee as portfolio.ts.
//
//   1. funnels.user_id = caller   -> bookings whose funnel_id is in that set
//   2. bookings.coach_user_id = caller
//
// A booking made through a coach's own /book/:slug page has funnel_id NULL by
// design — it came from no funnel — so fact 1 alone made it invisible to the
// coach forever. That is not a marginal case: the coach link is the rebooking
// path, handed to someone who already came through the funnel and needs another
// call without re-applying. Those are precisely the calls a coach must not miss.
//
// TWO SCOPED READS, MERGED IN CODE, rather than one query with .or(). The two
// arms are different predicates over different columns, and an .or() collapses
// them into a single expression whose precedence is easy to widen by accident
// and impossible to see the width of afterwards. Two `.eq`/`.in` reads each
// state their own scope in isolation and cannot be silently broadened by a
// change to the other.
export const config = { maxDuration: 30 }

const AGENDA_LIMIT = 200
const QUEUE_LIMIT = 200

// bookings has no lead_id — the link is (funnel_id, lower(email)), the same join
// lib/contacts.ts uses. Every row that needs a lead_id resolves through this.
const LEAD_COLUMNS = 'id, funnel_id, email, name, first_name, status, application_status, application_submitted_at'
const BOOKING_COLUMNS = 'id, funnel_id, coach_user_id, email, name, start_time, end_time, attended, status, zoom_join_url, meeting_url'

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
  // Selected so the coach-page arm below can test the THING (this booking names
  // this coach) rather than a proxy for it. Every row in `bookings` is already
  // owned by the caller one way or the other, so `funnel_id === null` happens to
  // coincide with it today — and a guard shaped like a container passes until
  // real data shares that container.
  coach_user_id: string | null
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

    // NO EARLY RETURN ON ZERO FUNNELS. Owning no funnels is not the same as
    // having no calendar: a coach with a booking page and no funnel used to get
    // an empty calendar permanently, however many people booked them. The funnel
    // arm is skipped instead — `.in('funnel_id', [])` is not a query worth
    // sending, and PostgREST's handling of an empty list is not something to
    // depend on either way.
    const nowIso = new Date().toISOString()

    // Both ownership arms, deduplicated and sorted — see lib/coachBookings.ts.
    // No status/window filter is passed: needs_outcome must span all time
    // regardless of the month window, so one pull serves all three arrays.
    const [bookings, leadsRes] = await Promise.all([
      loadOwnedActiveBookings<BookingRow>({ userId, funnelIds, columns: BOOKING_COLUMNS }),
      funnelIds.length
        ? supabase.from('funnel_leads').select(LEAD_COLUMNS).in('funnel_id', funnelIds)
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ])
    if (leadsRes.error) throw leadsRes.error

    const leads = (leadsRes.data || []) as LeadRow[]

    const leadByKey = new Map<string, LeadRow>()
    for (const l of leads) {
      const key = bookingKey(l.funnel_id, l.email)
      // Newest wins on a duplicate email within one funnel — the same "most
      // recent lead for this email" rule api/calendar/book.ts applies when it
      // attributes a booking.
      if (!leadByKey.has(key)) leadByKey.set(key, l)
    }
    // TWO SETS, TWO QUESTIONS. They are not one key with a wider shape:
    //
    //   bookedLeadKeys        "this lead booked through THIS funnel"
    //   coachPageBookedEmails "this coach has this PERSON on their calendar"
    //
    // Collapsing them into one keyspace is how the next reader loses the
    // distinction, and the distinction is load-bearing — see the funnel-A/B rule
    // below.
    const bookedLeadKeys = new Set(bookings.filter((b) => b.funnel_id).map((b) => bookingKey(b.funnel_id, b.email)))

    // The rebooking path. The coach link is handed to someone who already came
    // through the funnel and needs another call without reapplying, so an
    // approved lead who uses it is the CENTRAL case for this queue, not an edge
    // one. A recovery list whose purpose is "people you approved who are not on
    // your calendar" must not list people who are on your calendar.
    //
    // Keyed on email alone because there is no funnel to key on. Gated on
    // coach_user_id EXPLICITLY rather than on `funnel_id === null`: the two
    // coincide today only because every row here is already the caller's, and
    // that is a coincidence, not the rule being asserted.
    //
    // SUPPRESSION, NOT ATTRIBUTION — and the neighbouring file does the
    // opposite, so this is worth reading before assuming they match.
    // lib/contacts.ts must pick ONE contact for a coach-page call, because a
    // call has to land on a single row. Here nothing is being attributed: if
    // that address is an approved lead in two of the caller's funnels, BOTH
    // leave the queue, and both leaving is correct. The coach should not chase
    // that person from either funnel, because that person is on their calendar.
    //
    // Cancellation comes free and is asserted rather than assumed:
    // loadOwnedActiveBookings filters status='active', so a canceled coach-page
    // booking is not in `bookings` at all and its lead stays a recovery target —
    // identical to the funnel rule.
    const coachPageBookedEmails = new Set(
      bookings
        .filter((b) => !b.funnel_id && b.coach_user_id === userId)
        .map((b) => (b.email || '').trim().toLowerCase())
        .filter(Boolean)
    )

    // name falls back to email when null. Lead name first (what the coach knows
    // them as), then the booking form's name, then the address.
    const displayName = (lead: LeadRow | undefined, booking: BookingRow | null, email: string): string => {
      for (const v of [lead?.name, lead?.first_name, booking?.name]) {
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return email
    }

    // A COACH-PAGE BOOKING CAN NEVER RESOLVE A LEAD, and that is structural
    // rather than a gap to fill. `bookings` has no lead_id; the link is
    // (funnel_id, lower(email)), so a row with funnel_id NULL has no left half
    // to join on.
    //
    // THE PATTERN, not the instance. Three defects in two days have all been
    // this one derived join failing on a row it structurally cannot reach: the
    // call missing from the coach's calendar, the call missing from the contact
    // it belongs to, and the approved lead who had already rebooked. Each was
    // fixed with a second predicate. The next one will be too, until the link
    // stops being derived — the real fix is `bookings.lead_id`, which makes it
    // explicit instead of inferred from two columns that a whole class of rows
    // does not carry.
    //
    // ONE HOLE IS ACCEPTED DELIBERATELY, HERE, TODAY: a coach-page call that
    // HAPPENED is owed an outcome, and nothing will ever ask for it. needs_outcome
    // excludes it (below) because the close-out write is addressed by lead id and
    // would fail on click. Missing from a work queue beats a queue that throws —
    // but it is missing, not handled, and a predicate cannot fix it.
    //
    // It cannot accidentally match one either. funnel_leads.funnel_id is
    // NULLABLE, and bookingKey maps a null funnel to '' — so a funnel-less lead
    // would key identically to a coach-page booking. leadByKey is built only
    // from `.in('funnel_id', funnelIds)`, and SQL `in` never matches NULL, so no
    // such lead can enter the map. Zero exist today; this holds regardless.
    //
    // So lead_id is null on these rows BY CONSTRUCTION. Every consumer below
    // states what it does about that rather than inheriting it by accident.
    const resolveLead = (b: BookingRow): LeadRow | undefined =>
      b.funnel_id ? leadByKey.get(bookingKey(b.funnel_id, b.email)) : undefined

    const shape = (b: BookingRow) => {
      const lead = resolveLead(b)
      const funnel = b.funnel_id ? byFunnel.get(b.funnel_id) : undefined
      return {
        booking_id: b.id,
        // null for every coach-page booking. There is no lead to link to.
        lead_id: lead?.id ?? null,
        // Falls back to the booking form's name, then the address — a
        // coach-page booking always has one of those.
        name: displayName(lead, b, b.email),
        email: b.email,
        funnel_id: b.funnel_id,
        // NULL, not 'Unknown funnel'. Those mean different things: null is "this
        // call came from no funnel", which is a normal coach-page booking, while
        // 'Unknown funnel' is "there is a funnel_id we could not resolve", which
        // is a fault. Collapsing them would print a fault label on a healthy row.
        funnel_name: b.funnel_id ? funnelDisplayName(funnel) : null,
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
    //
    // A WORK QUEUE MAY ONLY CONTAIN ROWS WHOSE ACTION TARGET EXISTS, so a row
    // that cannot resolve a lead is excluded. Recording an outcome is
    // POST /api/leads/[leadId]/outcome — it is addressed by lead id and writes
    // funnel_leads.status, so a row with lead_id null has nothing to post to.
    // Listing it would put a button in the coach's queue that fails on click.
    //
    // That deliberately keeps coach-page calls OUT of this queue for now. They
    // are still owed an outcome and the gap is real; it is reported rather than
    // guessed at, because missing from a work queue is recoverable and a queue
    // that throws on click is not.
    //
    // It also closes a latent case that predates coach-page bookings: a FUNNEL
    // booking whose email matches no lead was already listed here with lead_id
    // null, and was already unusable. One predicate covers both.
    const needs_outcome = bookings
      .filter((b) => {
        if (!b.start_time) return false
        if (new Date(b.start_time).getTime() >= Date.now()) return false
        if (b.attended === 'no_show') return false
        const lead = resolveLead(b)
        if (!lead) return false
        return !TERMINAL.has(String(lead.status ?? ''))
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
        // Either arm removes them. A funnel booking still only clears a lead in
        // ITS OWN funnel: an approved lead in funnel A who books through funnel
        // B stays in A's recovery list, which is today's behaviour and is not
        // what this change touches. Only the funnel-LESS arm is email-keyed.
        if (coachPageBookedEmails.has((l.email || '').trim().toLowerCase())) return false
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
