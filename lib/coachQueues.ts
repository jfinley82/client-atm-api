import { WON_STATUSES, LOST_STATUS, bookingKey } from './contacts'

// THE COACH'S WORK QUEUES, as predicates, stated once.
//
// `needs_outcome` and `approved_not_booked` were inline in api/calendar/index.ts
// and are now read by two surfaces — the calendar and the My Business dashboard.
// A dashboard is a FAN-IN, and a fan-in is exactly where a fifth copy of a rule
// gets written because importing the fourth was inconvenient. These moved here
// before the second reader existed rather than after.
//
// Ownership is NOT here. That is lib/coachBookings.ts, and callers resolve their
// bookings through it before calling anything below. These functions take rows
// that are already scoped and decide only which of them are WORK.
//
// Pure: no database, no clock of their own. `now` is passed in so the same rows
// produce the same answer in a test as in a request.

export type QueueLead = {
  id: string
  funnel_id: string
  email: string
  name?: string | null
  first_name?: string | null
  status?: string | null
  application_status?: string | null
  application_submitted_at?: string | null
}

export type QueueBooking = {
  id: string
  funnel_id: string | null
  coach_user_id?: string | null
  email: string
  name?: string | null
  start_time: string | null
  attended?: string | null
}

/** A deal already decided is not owed a call outcome and is not a recovery target. */
export const TERMINAL_LEAD_STATUSES = new Set<string>([...WON_STATUSES, LOST_STATUS])

/**
 * The gate writes application_status ∈ ('applied'|'qualified'|'disqualified').
 * There is no 'approved' value in the schema — 'qualified' IS the approved state.
 */
export const APPROVED_APPLICATION_STATUS = 'qualified'

/**
 * Which lead a booking belongs to.
 *
 * A COACH-PAGE BOOKING CAN NEVER RESOLVE ONE, structurally rather than as a gap
 * to fill: `bookings` has no lead_id on these rows, and the link is
 * (funnel_id, lower(email)), so a row with funnel_id null has no left half to
 * join on. `bookings.lead_id` (096) is the real fix and is deliberately not read
 * here yet — the backfill covers 3 of 12 rows, so a reader that trusted it would
 * lose the funnel-less-but-coached rows this join still finds.
 *
 * It cannot accidentally match one either: funnel_leads.funnel_id is nullable and
 * bookingKey maps a null funnel to '', so a funnel-less lead would key
 * identically to a coach-page booking — but the index is built only from leads
 * fetched by `.in('funnel_id', funnelIds)`, and SQL `in` never matches NULL, so
 * no such lead can enter it.
 */
export function buildLeadResolver<L extends QueueLead, B extends QueueBooking>(leads: L[]): (b: B) => L | undefined {
  const byKey = new Map<string, L>()
  for (const l of leads) {
    const key = bookingKey(l.funnel_id, l.email)
    // Newest wins on a duplicate address within one funnel — the same "most
    // recent lead for this email" rule api/calendar/book.ts applies.
    if (!byKey.has(key)) byKey.set(key, l)
  }
  return (b: B) => (b.funnel_id ? byKey.get(bookingKey(b.funnel_id, b.email)) : undefined)
}

/**
 * A past call still owed a DEAL outcome.
 *
 * What clears it is the deal being decided, never the mere presence of an
 * attendance mark:
 *
 *   won / lost          -> cleared. The lead's status is the record of it.
 *   no_show             -> cleared. The call never happened.
 *   showed, undecided   -> STILL LISTED, and this is the most important row here.
 *   unmarked, undecided -> still listed.
 *
 * Deliberately NOT `attended is not null`: that conflates attendance with
 * outcome and hides exactly the calls most in need of closing out.
 *
 * A WORK QUEUE MAY ONLY CONTAIN ROWS WHOSE ACTION TARGET EXISTS. Recording an
 * outcome is POST /api/leads/[leadId]/outcome — addressed by lead id — so a row
 * that resolves no lead has nothing to post to and is excluded. That keeps
 * coach-page calls out of this queue: they are still owed an outcome and the gap
 * is real, but missing from a work queue is recoverable and a queue that throws
 * on click is not.
 */
// GENERIC OVER THE CALLER'S ROW TYPE, deliberately. Returning QueueBooking would
// widen every caller's rows to the narrow shared shape and force a cast back —
// and a cast is a place to be wrong about the thing that was just filtered.
export function needsOutcome<B extends QueueBooking>(
  bookings: B[],
  resolveLead: (b: B) => QueueLead | undefined,
  nowMs: number
): B[] {
  return bookings
    .filter((b) => {
      if (!b.start_time) return false
      if (new Date(b.start_time).getTime() >= nowMs) return false
      if (b.attended === 'no_show') return false
      const lead = resolveLead(b)
      if (!lead) return false
      return !TERMINAL_LEAD_STATUSES.has(String(lead.status ?? ''))
    })
    // Most overdue first — the oldest unclosed call is the most urgent.
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
}

/**
 * Qualified applicants who never booked — the recovery list.
 *
 * TWO SETS, TWO QUESTIONS, and collapsing them loses the distinction:
 *
 *   bookedLeadKeys        "this lead booked through THIS funnel"
 *   coachPageBookedEmails "this coach has this PERSON on their calendar"
 *
 * Either removes them. A funnel booking still only clears a lead in its OWN
 * funnel — an approved lead in funnel A who books through funnel B stays in A's
 * list — while the funnel-less arm is email-keyed, because there is no funnel to
 * key on. If that address is approved in two of the coach's funnels, both leave,
 * and both leaving is correct: the coach should not chase someone who is already
 * on their calendar.
 *
 * Cancellation comes free rather than being handled: callers pass bookings
 * resolved with status='active', so a canceled booking is not in the set at all
 * and its lead stays a recovery target.
 */
export function approvedNotBooked<L extends QueueLead>(leads: L[], bookings: QueueBooking[], coachUserId: string): L[] {
  const bookedLeadKeys = new Set(bookings.filter((b) => b.funnel_id).map((b) => bookingKey(b.funnel_id, b.email)))
  const coachPageBookedEmails = new Set(
    bookings
      .filter((b) => !b.funnel_id && b.coach_user_id === coachUserId)
      .map((b) => (b.email || '').trim().toLowerCase())
      .filter(Boolean)
  )

  return leads
    .filter((l) => {
      if (l.application_status !== APPROVED_APPLICATION_STATUS) return false
      if (TERMINAL_LEAD_STATUSES.has(String(l.status ?? ''))) return false
      if (coachPageBookedEmails.has((l.email || '').trim().toLowerCase())) return false
      return !bookedLeadKeys.has(bookingKey(l.funnel_id, l.email))
    })
    // funnel_leads has no approved_at column. The gate decides qualified vs
    // disqualified AT submission, so the submission timestamp IS when they were
    // approved. Most recently approved first.
    .sort((a, b) => String(b.application_submitted_at || '').localeCompare(String(a.application_submitted_at || '')))
}

/**
 * A lead nobody has done anything with.
 *
 * NOT "never contacted". Nothing in the schema records a coach contacting a
 * lead — there is no contacted_at, funnel_lead_notes holds no rows, and
 * optin_notified_at is US notifying the COACH. "Never contacted" would be a
 * claim about the coach's behaviour that the data cannot support; this is a
 * claim about the record, which it can.
 *
 * NURTURE EMAILS ARE DELIBERATELY NOT ACTIVITY. They go out automatically, so
 * counting them would empty this queue without anyone having done anything —
 * which is the opposite of what the queue is for. Do not "fix" this by adding
 * them.
 */
export function noActivity<L extends QueueLead>(
  leads: L[],
  opts: { bookedEmails: Set<string>; leadIdsWithNotes: Set<string> }
): L[] {
  return leads
    .filter((l) => {
      if (String(l.status ?? '') !== 'lead') return false
      if (l.application_submitted_at) return false
      if (opts.leadIdsWithNotes.has(l.id)) return false
      return !opts.bookedEmails.has((l.email || '').trim().toLowerCase())
    })
    // Oldest first: age is the reason they are on this list.
    .sort((a, b) => String((a as any).created_at || '').localeCompare(String((b as any).created_at || '')))
}
