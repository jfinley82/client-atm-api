// `approved_not_booked` is "people you approved who are NOT on your calendar".
//
// It was funnel-keyed only, so an approved lead who rebooked through the coach's
// own booking link stayed in it — and the coach link is precisely the rebooking
// path for the people this queue tracks. The queue sent the coach to chase
// someone they were about to meet.
//
// PRODUCTION CANNOT DEMONSTRATE THIS. Verified live: 2 qualified leads, 1 active
// coach-page booking, and ZERO coach-page bookings sharing an address with a
// qualified lead. So a green run against real rows would prove the code path and
// not the fix; the fixture has to isolate the variable, and every case below is
// built as a pair — the state that must suppress and the neighbouring state that
// must not.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'

import { projectSelect } from './support/postgrest'
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0,
  fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++
    console.log('  PASS', label)
  } else {
    fail++
    console.log('  FAIL', label, extra ? '\n      ' + extra : '')
  }
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// Live production values.
const JAMAUL = '5c8ba4ad-0c04-4816-9fcf-b0b988a74ae6'
const OTHER_COACH = '0728feac-931a-42dd-9d87-053eea7fd88d'
// The first active coach-page booking that has ever existed.
const REAL_COACH_PAGE_BOOKING = '2bf60b0b-040b-4096-b021-8a9d6b1287d5'

const A = 'funnel-a'
const B = 'funnel-b'
const OTHER_FUNNEL = 'funnel-other'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = Date.now()
const REBOOKER = 'rebooker@example.com'

let funnels: any[] = []
let leads: any[] = []
let bookings: any[] = []
let bookingQueries: string[] = []
// When true the coach arm also returns a booking that is NOT the caller's, so
// the handler's own coach_user_id test can be exercised. Nothing can produce
// that today — loadOwnedActiveBookings filters it out — which is exactly why
// the explicit test is otherwise unobservable and would look decorative.
let leakUnownedCoachPageBooking: any = null

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(projectSelect(url, b)), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) return json({ status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })
  if (url.includes('/rest/v1/user_availability')) return json(null)

  if (url.includes('/rest/v1/funnels')) {
    const owner = eqParam(url, 'user_id')
    return json(funnels.filter((f) => f.user_id === owner))
  }

  if (url.includes('/rest/v1/funnel_leads')) {
    const ids = inParam(url, 'funnel_id')
    return json(leads.filter((l) => (ids ? l.funnel_id != null && ids.includes(l.funnel_id) : true)))
  }

  if (url.includes('/rest/v1/bookings')) {
    bookingQueries.push(url)
    const ids = inParam(url, 'funnel_id')
    const coach = eqParam(url, 'coach_user_id')
    const status = eqParam(url, 'status')
    let rows = bookings
    if (ids) rows = rows.filter((b) => b.funnel_id != null && ids.includes(b.funnel_id))
    if (coach) rows = rows.filter((b) => b.coach_user_id === coach)
    if (status) rows = rows.filter((b) => b.status === status)
    if (coach && leakUnownedCoachPageBooking) rows = [...rows, leakUnownedCoachPageBooking]
    rows = rows.slice().sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))

    // Column projection now lives in tests/support/postgrest.ts and is applied
    // by `json` for every stub in the suite — this file had the only copy.
    return json(rows)
  }

  return json([])
}) as typeof fetch

async function call(handler: Handler, userId: string, query: Record<string, string> = {}) {
  const token = await createSessionToken(userId)
  let status = 0
  let body: any = null
  const res: any = {
    setHeader() {},
    status(c: number) {
      status = c
      return res
    },
    json(v: unknown) {
      body = v
      return res
    },
    end() {
      return res
    },
  }
  bookingQueries = []
  await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query, body: null } as any, res)
  return { status, body }
}

// Written out independently of the handler.
const recoveryIds = (b: any) => ((b && b.approved_not_booked) || []).map((r: any) => r.lead_id).sort()

const approvedLead = (over: Record<string, any> = {}) => ({
  id: 'lead-a',
  funnel_id: A,
  email: REBOOKER,
  name: 'Rebooking Client',
  first_name: 'Rebooking',
  status: 'new',
  // Production's real vocabulary: null (5), disqualified (3), qualified (2).
  // There is no 'approved' value.
  application_status: 'qualified',
  application_submitted_at: iso(NOW - 10 * DAY),
  ...over,
})

const coachPageBooking = (over: Record<string, any> = {}) => ({
  id: REAL_COACH_PAGE_BOOKING,
  funnel_id: null,
  coach_user_id: JAMAUL,
  email: REBOOKER,
  name: 'Rebooking Client',
  start_time: iso(NOW + 4 * DAY),
  end_time: iso(NOW + 4 * DAY),
  attended: null,
  status: 'active',
  zoom_join_url: 'https://zoom.us/j/rebook',
  meeting_url: null,
  ...over,
})

const funnelBooking = (over: Record<string, any> = {}) => ({
  id: 'bk-funnel',
  funnel_id: A,
  coach_user_id: null,
  email: REBOOKER,
  name: 'Rebooking Client',
  start_time: iso(NOW + 6 * DAY),
  end_time: iso(NOW + 6 * DAY),
  attended: null,
  status: 'active',
  zoom_join_url: null,
  meeting_url: null,
  ...over,
})

const FUNNEL_A = { id: A, user_id: JAMAUL, subdomain: 'a', problem_solution_label: 'Alpha', landing_page: null }
const FUNNEL_B = { id: B, user_id: JAMAUL, subdomain: 'b', problem_solution_label: 'Beta', landing_page: null }

;(async () => {
  const { default: handler } = await import('../api/calendar/index')

  console.log('\n-- ACCEPTANCE 1+2: THE PAIR. Active suppresses; canceled does not --')
  {
    // One without the other proves nothing: a filter that removes everything and
    // a filter that removes the right thing both make case 1 pass.
    funnels = [FUNNEL_A]
    leads = [approvedLead()]

    bookings = [coachPageBooking()]
    const active = await call(handler, JAMAUL)
    eq('200', active.status, 200)
    eq('an active coach-page booking clears them', recoveryIds(active.body), [])

    bookings = [coachPageBooking({ status: 'canceled' })]
    const canceled = await call(handler, JAMAUL)
    eq('a CANCELED one leaves them a recovery target', recoveryIds(canceled.body), ['lead-a'])

    // Not a status check in the queue — loadOwnedActiveBookings filters
    // status='active' in SQL, so the row is never in `bookings` at all. Pinned
    // against the QUERIES rather than asserted as prose, so removing that SQL
    // filter fails here instead of silently moving the rule into the queue.
    ok('every booking read filtered on active in SQL',
       bookingQueries.length > 0 && bookingQueries.every((u) => u.includes('status=eq.active')),
       JSON.stringify(bookingQueries))
  }

  console.log('\n-- ACCEPTANCE 3: a funnel booking must NOT clear a lead in another funnel --')
  {
    // The scope that must not widen. Same person, approved in A, books through
    // B. They stay in A's recovery list — today's behaviour, untouched.
    funnels = [FUNNEL_A, FUNNEL_B]
    leads = [approvedLead({ id: 'lead-in-a', funnel_id: A })]
    bookings = [funnelBooking({ id: 'bk-in-b', funnel_id: B })]

    const r = await call(handler, JAMAUL)
    eq('the lead in funnel A still appears', recoveryIds(r.body), ['lead-in-a'])

    // The discriminating neighbour: the SAME booking moved into funnel A does
    // clear them. Only the funnel differs, so only the funnel can explain it.
    bookings = [funnelBooking({ id: 'bk-in-a', funnel_id: A })]
    const sameFunnel = await call(handler, JAMAUL)
    eq('but a booking in their OWN funnel clears them', recoveryIds(sameFunnel.body), [])
  }

  console.log('\n-- ACCEPTANCE 4: an own-funnel booking still suppresses, unchanged --')
  {
    funnels = [FUNNEL_A]
    leads = [approvedLead()]
    bookings = [funnelBooking()]
    eq('unchanged behaviour', recoveryIds((await call(handler, JAMAUL)).body), [])

    bookings = [funnelBooking({ status: 'canceled' })]
    eq('and canceled still leaves them listed', recoveryIds((await call(handler, JAMAUL)).body), ['lead-a'])
  }

  console.log('\n-- ACCEPTANCE 5: another coach’s calendar clears nobody of mine --')
  {
    funnels = [FUNNEL_A, { ...FUNNEL_A, id: OTHER_FUNNEL, user_id: OTHER_COACH }]
    leads = [approvedLead()]
    // Identical address, identical time, identical shape. ONLY the owning coach
    // differs, so only ownership can separate them.
    bookings = [coachPageBooking({ id: 'cp-theirs', coach_user_id: OTHER_COACH })]

    const r = await call(handler, JAMAUL)
    eq('coach B’s booking does not clear coach A’s lead', recoveryIds(r.body), ['lead-a'])

    // The same fixture with the owner flipped DOES clear them — proving the
    // assertion above turns on coach_user_id and not on something incidental.
    bookings = [coachPageBooking({ id: 'cp-mine', coach_user_id: JAMAUL })]
    eq('and their own does', recoveryIds((await call(handler, JAMAUL)).body), [])
  }

  console.log('\n-- ACCEPTANCE 7: SUPPRESSION, not attribution — both leads leave --')
  {
    // lib/contacts.ts must choose ONE contact for a coach-page call, because a
    // call has to land on a single row. Nothing is being attributed here, so if
    // that address is approved in two of the caller's funnels, BOTH go.
    funnels = [FUNNEL_A, FUNNEL_B]
    leads = [approvedLead({ id: 'lead-in-a', funnel_id: A }), approvedLead({ id: 'lead-in-b', funnel_id: B })]

    bookings = []
    eq('both are listed with no booking', recoveryIds((await call(handler, JAMAUL)).body), ['lead-in-a', 'lead-in-b'])

    bookings = [coachPageBooking()]
    const r = await call(handler, JAMAUL)
    // The count is the assertion, so the decision is pinned rather than
    // commented: one leaving would be attribution leaking in from the neighbour.
    eq('one coach-page booking removes BOTH', recoveryIds(r.body), [])
    eq('and the queue is empty, not merely shorter', (r.body?.approved_not_booked || []).length, 0)
  }

  console.log('\n-- ACCEPTANCE 6: the other two arrays are byte-identical --')
  {
    // This change touches ONE queue. agenda and needs_outcome must be unchanged
    // for the same input, so the comparison is between two runs of the same
    // fixture that differ ONLY in whether the coach-page booking exists.
    const past = iso(NOW - 5 * DAY)
    funnels = [FUNNEL_A]
    leads = [
      approvedLead(),
      { ...approvedLead({ id: 'lead-past', email: 'past@example.com' }), application_status: null },
    ]
    const baseBookings = [
      funnelBooking({ id: 'bk-past', email: 'past@example.com', start_time: past, end_time: past }),
      funnelBooking({ id: 'bk-future' }),
    ]

    bookings = [...baseBookings]
    const without = await call(handler, JAMAUL)

    bookings = [...baseBookings, coachPageBooking()]
    const withCp = await call(handler, JAMAUL)

    // needs_outcome is untouched: a coach-page booking cannot resolve a lead, so
    // it is excluded there for a different and unrelated reason.
    eq('needs_outcome is byte-identical', JSON.stringify(withCp.body?.needs_outcome), JSON.stringify(without.body?.needs_outcome))
    // agenda GAINS the coach-page call, which is the calendar-scope change and
    // not this one — asserted so "identical" cannot be read as "agenda ignores
    // coach-page bookings".
    const agendaIds = (b: any) => ((b && b.agenda) || []).map((r: any) => r.booking_id).sort()
    eq('agenda without it', agendaIds(without.body), ['bk-future'])
    eq('agenda with it gains exactly that row', agendaIds(withCp.body), [REAL_COACH_PAGE_BOOKING, 'bk-future'].sort())

    // ...and both fixtures actually populated the queues, or "identical" would
    // be two empty arrays agreeing.
    ok('needs_outcome was non-empty in both runs', (without.body?.needs_outcome || []).length === 1, JSON.stringify(without.body?.needs_outcome))
  }

  console.log('\n-- the arm is gated on coach_user_id, not on funnel_id being null --')
  {
    // The proxy trap. Every row in `bookings` is already owned by the caller, so
    // `funnel_id === null` coincides with "mine" today. This fixture breaks the
    // coincidence: a funnel-less booking that is NOT the caller's.
    funnels = [FUNNEL_A]
    leads = [approvedLead()]
    bookings = [coachPageBooking({ id: 'cp-unowned', coach_user_id: OTHER_COACH })]

    // First line of defence: the ownership query never returns it.
    eq('the query never surfaces another coach’s funnel-less booking', recoveryIds((await call(handler, JAMAUL)).body), ['lead-a'])

    // SECOND line, and the one the handler owns. The check above is satisfied by
    // the QUERY, so it cannot tell whether the arm tests coach_user_id or merely
    // `funnel_id === null` — those coincide on every row the query can return.
    // Here the stub hands one through anyway, which is what a future change to
    // the ownership read would do. Swapping the arm to the funnel_id proxy fails
    // exactly here.
    bookings = []
    leakUnownedCoachPageBooking = coachPageBooking({ id: 'cp-leaked', coach_user_id: OTHER_COACH })
    const leaked = await call(handler, JAMAUL)
    leakUnownedCoachPageBooking = null
    eq('and handed one directly, the arm still refuses it', recoveryIds(leaked.body), ['lead-a'])

    // A null coach_user_id with a null funnel_id — the legacy shared-Zoom shape —
    // is likewise not "mine" on this arm.
    bookings = [coachPageBooking({ id: 'cp-orphan', coach_user_id: null })]
    eq('nor does an unowned shared-Zoom booking', recoveryIds((await call(handler, JAMAUL)).body), ['lead-a'])
  }

  console.log('\n-- terminal and unapproved leads are unaffected --')
  {
    funnels = [FUNNEL_A]
    leads = [
      approvedLead({ id: 'lead-approved' }),
      approvedLead({ id: 'lead-unapproved', email: 'u@example.com', application_status: null }),
      approvedLead({ id: 'lead-disq', email: 'd@example.com', application_status: 'disqualified' }),
      approvedLead({ id: 'lead-won', email: 'w@example.com', status: 'sold' }),
    ]
    bookings = []
    eq('only the approved, undecided lead is a recovery target', recoveryIds((await call(handler, JAMAUL)).body), ['lead-approved'])
  }

  console.log('\n-- address case drifts between the opt-in row and the booking form --')
  {
    funnels = [FUNNEL_A]
    leads = [approvedLead({ email: 'ReBooker@Example.com' })]
    bookings = [coachPageBooking({ email: 'rebooker@EXAMPLE.com' })]
    eq('they are still cleared', recoveryIds((await call(handler, JAMAUL)).body), [])
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
