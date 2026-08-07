// GET /api/calendar must show a coach the calls made through their OWN booking
// page, not just the ones that came through a funnel.
//
// The defect: every booking query was scoped `.in('funnel_id', ownedFunnelIds)`,
// and a /book/:slug booking has funnel_id NULL by design. So it could not appear
// in `agenda` at all, and a coach with a booking page but no funnels hit an
// early return that gave them a permanently empty calendar.
//
// REAL PRODUCTION IDENTIFIERS throughout. The coach ids and the coach-page
// booking id below are the live values; a fixture that shares no id or shape
// with production proves nothing about production.

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
const JAMAUL = '5c8ba4ad-0c04-4816-9fcf-b0b988a74ae6' // admin, booking_slug 'jamaul'
const OTHER_COACH = '0728feac-931a-42dd-9d87-053eea7fd88d' // a real second user
const COACH_PAGE_BOOKING = '436c8e5b-bf4a-42c0-8159-2acc54531080' // funnel_id null, coach_user_id JAMAUL

const F1 = 'funnel-1'
const OTHER_FUNNEL = 'funnel-other'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = Date.now()

let funnels: any[] = []
let leads: any[] = []
let bookings: any[] = []

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}

// Every request the handler makes, so the test can assert the SHAPE of the
// access control and not only its output.
let bookingQueries: string[] = []
// When true the leads stub ignores the `in` filter and returns funnel-less rows
// too, so the handler's own guard can be exercised rather than the query's.
let leakOrphanLead = false
let lastLeadsPayloadHadOrphan = false

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
    // SQL `in` NEVER MATCHES NULL. Modelled deliberately: the safety of the
    // coach-page lead path depends on it, and a mock without the real
    // semantics would pass a design the database rejects.
    const out = leads.filter((l) => (leakOrphanLead ? true : ids ? l.funnel_id != null && ids.includes(l.funnel_id) : true))
    lastLeadsPayloadHadOrphan = out.some((l) => l.funnel_id == null)
    return json(out)
  }

  if (url.includes('/rest/v1/bookings')) {
    bookingQueries.push(url)
    const ids = inParam(url, 'funnel_id')
    const coach = eqParam(url, 'coach_user_id')
    const status = eqParam(url, 'status')
    // gte/limit are modelled because `refine` is otherwise unobservable: without
    // them, applying it to one arm instead of both makes no difference to any
    // output, and the guard against that is decorative.
    const gte = /[?&]start_time=gte\.([^&]+)/.exec(url)?.[1]
    const limit = /[?&]limit=(\d+)/.exec(url)?.[1]
    let rows = bookings
    if (ids) rows = rows.filter((b) => b.funnel_id != null && ids.includes(b.funnel_id))
    if (coach) rows = rows.filter((b) => b.coach_user_id === coach)
    if (status) rows = rows.filter((b) => b.status === status)
    if (gte) rows = rows.filter((b) => String(b.start_time) >= decodeURIComponent(gte))
    rows = rows.slice().sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
    if (limit) rows = rows.slice(0, Number(limit))
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

// Predicates written out independently of the handler.
const agendaIds = (b: any) => ((b && b.agenda) || []).map((r: any) => r.booking_id)
const outcomeIds = (b: any) => ((b && b.needs_outcome) || []).map((r: any) => r.booking_id)

const coachPageRow = (over: Partial<Record<string, any>> = {}) => ({
  id: COACH_PAGE_BOOKING,
  funnel_id: null,
  coach_user_id: JAMAUL,
  email: 'rebooker@example.com',
  name: 'Rebooking Client',
  start_time: iso(NOW + 2 * DAY),
  end_time: iso(NOW + 2 * DAY + 1800_000),
  attended: null,
  status: 'active',
  zoom_join_url: 'https://zoom.us/j/coachpage',
  meeting_url: null,
  ...over,
})

const funnelRow = (over: Partial<Record<string, any>> = {}) => ({
  id: 'bk-funnel',
  funnel_id: F1,
  coach_user_id: null,
  email: 'lead@example.com',
  name: 'Funnel Lead',
  start_time: iso(NOW + 5 * DAY),
  end_time: iso(NOW + 5 * DAY + 1800_000),
  attended: null,
  status: 'active',
  zoom_join_url: null,
  meeting_url: 'https://meet.google.com/x',
  ...over,
})

;(async () => {
  const { default: handler } = await import('../api/calendar/index')

  console.log('\n-- ACCEPTANCE 1+2: both kinds appear, in the same run --')
  {
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = [{ id: 'lead-1', funnel_id: F1, email: 'lead@example.com', name: 'Funnel Lead', first_name: null, status: 'new', application_status: 'qualified', application_submitted_at: iso(NOW - DAY) }]
    bookings = [coachPageRow(), funnelRow()]

    const r = await call(handler, JAMAUL)
    eq('200', r.status, 200)
    // (1) the coach-page booking, which was invisible before.
    ok('the coach-page booking is in agenda', agendaIds(r.body).includes(COACH_PAGE_BOOKING), JSON.stringify(agendaIds(r.body)))
    // (2) the funnel booking, unchanged.
    ok('the funnel booking is still in agenda', agendaIds(r.body).includes('bk-funnel'), JSON.stringify(agendaIds(r.body)))
    eq('and nothing else', agendaIds(r.body).length, 2)

    // Ascending, which merging two sorted lists does NOT give for free.
    eq('agenda is ascending by start_time', agendaIds(r.body), [COACH_PAGE_BOOKING, 'bk-funnel'])
  }

  console.log('\n-- agenda ordering survives the merge, INTERLEAVED --')
  {
    // The two-row fixture above cannot test this: with one row per arm, several
    // wrong merges (including simply reversing) still come out ascending. These
    // rows interleave in time but arrive grouped by arm, so concatenation order
    // and time order genuinely disagree.
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = []
    bookings = [
      funnelRow({ id: 'fn-1', start_time: iso(NOW + 1 * DAY), end_time: iso(NOW + 1 * DAY) }),
      funnelRow({ id: 'fn-3', start_time: iso(NOW + 3 * DAY), end_time: iso(NOW + 3 * DAY) }),
      funnelRow({ id: 'fn-5', start_time: iso(NOW + 5 * DAY), end_time: iso(NOW + 5 * DAY) }),
      coachPageRow({ id: 'cp-2', start_time: iso(NOW + 2 * DAY), end_time: iso(NOW + 2 * DAY) }),
      coachPageRow({ id: 'cp-4', start_time: iso(NOW + 4 * DAY), end_time: iso(NOW + 4 * DAY) }),
    ]

    const r = await call(handler, JAMAUL)
    eq('strictly interleaved by time, not grouped by arm', agendaIds(r.body), ['fn-1', 'cp-2', 'fn-3', 'cp-4', 'fn-5'])

    // Written out independently, so the assertion does not depend on the literal
    // above being right.
    const times = (r.body?.agenda || []).map((x: any) => x.start_time)
    ok('and non-decreasing by start_time', times.every((t: string, i: number) => i === 0 || times[i - 1] <= t), JSON.stringify(times))

    // Two scoped reads, not one .or().
    ok('no query uses an or() across the two arms', !bookingQueries.some((u) => /[?&]or=/.test(u)), JSON.stringify(bookingQueries))
    ok('one arm scopes on funnel_id', bookingQueries.some((u) => /funnel_id=in\./.test(u)))
    ok('the other scopes coach_user_id to exactly the caller', bookingQueries.some((u) => u.includes(`coach_user_id=eq.${JAMAUL}`)))
  }

  console.log('\n-- ACCEPTANCE 3: a row owned BOTH ways appears once --')
  {
    // api/calendar/book.ts sets funnel_id AND coach_user_id on every funnel
    // booking it creates, so this row is what production produces next. Both
    // arms return it.
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = []
    bookings = [funnelRow({ id: 'bk-both', coach_user_id: JAMAUL })]

    const r = await call(handler, JAMAUL)
    eq('present exactly once', agendaIds(r.body), ['bk-both'])
    eq('and once in the payload, not two identical objects', agendaIds(r.body).length, 1)
  }

  console.log('\n-- ACCEPTANCE 4: zero funnels is not an empty calendar --')
  {
    // The early-return path. This coach owns no funnels at all.
    funnels = []
    leads = []
    bookings = [coachPageRow()]

    const r = await call(handler, JAMAUL)
    eq('200', r.status, 200)
    eq('the coach-page booking is there', agendaIds(r.body), [COACH_PAGE_BOOKING])
    // The funnel arm must be skipped rather than sent with an empty list.
    ok('no funnel_id=in.() query was sent', !bookingQueries.some((u) => /funnel_id=in\.\(\)/.test(u)), JSON.stringify(bookingQueries))
    ok('but the coach arm still was', bookingQueries.some((u) => u.includes(`coach_user_id=eq.${JAMAUL}`)))
  }

  console.log('\n-- ACCEPTANCE 5: neither arm leaks another coach’s calls --')
  {
    funnels = [
      { id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Mine', landing_page: null },
      { id: OTHER_FUNNEL, user_id: OTHER_COACH, subdomain: 'other', problem_solution_label: 'Theirs', landing_page: null },
    ]
    leads = []
    bookings = [
      coachPageRow(),
      funnelRow(),
      // The other coach's two kinds, held identical in every respect except
      // ownership — same times, same shape — so only ownership can separate them.
      coachPageRow({ id: 'bk-other-coachpage', coach_user_id: OTHER_COACH }),
      funnelRow({ id: 'bk-other-funnel', funnel_id: OTHER_FUNNEL, coach_user_id: OTHER_COACH }),
    ]

    const mine = await call(handler, JAMAUL)
    const theirs = await call(handler, OTHER_COACH)

    // Both sides must be NON-EMPTY before any "cannot see" assertion means
    // anything: an empty agenda satisfies every leak check trivially, which is
    // exactly how this section passed while reading the wrong object.
    ok('coach A\u2019s agenda is non-empty', agendaIds(mine.body).length === 2, JSON.stringify(agendaIds(mine.body)))
    ok('coach B\u2019s agenda is non-empty', agendaIds(theirs.body).length === 2, JSON.stringify(agendaIds(theirs.body)))

    eq('coach A sees only their own two', agendaIds(mine.body).sort(), [COACH_PAGE_BOOKING, 'bk-funnel'].sort())
    eq('coach B sees only their own two', agendaIds(theirs.body).sort(), ['bk-other-coachpage', 'bk-other-funnel'].sort())

    // Stated as the leak, by id, in both directions.
    ok('A cannot see B’s coach-page call', !agendaIds(mine.body).includes('bk-other-coachpage'))
    ok('A cannot see B’s funnel call', !agendaIds(mine.body).includes('bk-other-funnel'))
    ok('B cannot see A’s coach-page call', !agendaIds(theirs.body).includes(COACH_PAGE_BOOKING))
    ok('B cannot see A’s funnel call', !agendaIds(theirs.body).includes('bk-funnel'))
    ok('and B’s coach arm named B, not A', bookingQueries.some((u) => u.includes(`coach_user_id=eq.${OTHER_COACH}`)))
  }

  console.log('\n-- ACCEPTANCE 6: ?month= behaves identically for both kinds --')
  {
    const inMonth = new Date(Date.UTC(2026, 10, 15, 12, 0, 0)).toISOString() // 2026-11
    const outMonth = new Date(Date.UTC(2026, 11, 15, 12, 0, 0)).toISOString() // 2026-12

    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Mine', landing_page: null }]
    leads = []
    bookings = [
      coachPageRow({ id: 'cp-in', start_time: inMonth, end_time: inMonth }),
      coachPageRow({ id: 'cp-out', start_time: outMonth, end_time: outMonth }),
      funnelRow({ id: 'fn-in', start_time: inMonth, end_time: inMonth }),
      funnelRow({ id: 'fn-out', start_time: outMonth, end_time: outMonth }),
    ]

    const r = await call(handler, JAMAUL, { month: '2026-11' })
    eq('the month echoes back', r.body?.month, '2026-11')
    // The pair that matters: one of each kind in, one of each kind out. A month
    // filter that treated the two differently would show three or one.
    eq('exactly the in-month rows, both kinds', agendaIds(r.body).slice().sort(), ['cp-in', 'fn-in'])

    const past = await call(handler, JAMAUL, { month: '2020-01' })
    eq('an empty month is empty for both kinds', agendaIds(past.body), [])

    const bad = await call(handler, JAMAUL, { month: 'nope' })
    eq('a malformed month is still 400', bad.status, 400)
  }

  console.log('\n-- the null-lead path is explicit, not incidental --')
  {
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = [{ id: 'lead-1', funnel_id: F1, email: 'lead@example.com', name: 'Funnel Lead', first_name: null, status: 'new', application_status: null, application_submitted_at: null }]
    bookings = [coachPageRow(), funnelRow()]

    const r = await call(handler, JAMAUL)
    const cp = (r.body?.agenda || []).find((x: any) => x.booking_id === COACH_PAGE_BOOKING) ?? {}
    const fn = (r.body?.agenda || []).find((x: any) => x.booking_id === 'bk-funnel') ?? {}

    eq('a coach-page booking has no lead', cp.lead_id, null)
    eq('and no funnel id', cp.funnel_id, null)
    // NOT 'Unknown funnel' — null means "came from no funnel", which is healthy;
    // 'Unknown funnel' means "a funnel_id we could not resolve", which is a fault.
    eq('and funnel_name is null, not the fault label', cp.funnel_name, null)
    ok('it still has a usable display name', cp.name === 'Rebooking Client', cp.name)
    eq('and its join link survives', cp.zoom_join_url, 'https://zoom.us/j/coachpage')

    // The funnel row is untouched by any of this.
    eq('a funnel booking still resolves its lead', fn.lead_id, 'lead-1')
    eq('and still names its funnel', fn.funnel_name, 'Coaches')
  }

  console.log('\n-- a funnel-less LEAD can never be matched to a coach-page booking --')
  {
    // bookingKey maps a null funnel to '', so a funnel-less lead keys identically
    // to a coach-page booking. funnel_leads.funnel_id IS nullable, so this is a
    // real shape, not a hypothetical. The leads read is `.in('funnel_id', ids)`
    // and SQL `in` never matches NULL, so it can never enter the map.
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    const orphan = { id: 'lead-orphan', funnel_id: null, email: 'rebooker@example.com', name: 'Orphan Lead', first_name: null, status: 'new', application_status: null, application_submitted_at: null }
    leads = [orphan]
    bookings = [coachPageRow()]

    const r = await call(handler, JAMAUL)
    const cp = (r.body?.agenda || []).find((x: any) => x.booking_id === COACH_PAGE_BOOKING) ?? {}
    // First line of defence: the `.in('funnel_id', ids)` read cannot return it.
    ok('the query never surfaces a funnel-less lead', cp.lead_id === null, JSON.stringify(cp))

    // SECOND line of defence, and the one the handler owns. The check above is
    // satisfied by the QUERY, so it cannot tell whether the handler is also
    // safe — removing the handler's own null-funnel guard left it green.
    // Here the stub deliberately hands the orphan through anyway, which is what
    // a future change to the leads read would do.
    leakOrphanLead = true
    const leaked = await call(handler, JAMAUL)
    leakOrphanLead = false
    const cp2 = (leaked.body?.agenda || []).find((x: any) => x.booking_id === COACH_PAGE_BOOKING) ?? {}
    ok('and even handed one directly, the handler refuses to attach it', cp2.lead_id === null, JSON.stringify(cp2))
    ok('nor does its name bleed through', cp2.name !== 'Orphan Lead', cp2.name)
    // The fixture must actually be delivering the orphan, or the two lines above
    // are testing nothing.
    ok('(the leak fixture really did return the orphan)', lastLeadsPayloadHadOrphan, 'stub did not deliver it')
  }

  console.log('\n-- needs_outcome contains only rows whose action target exists --')
  {
    const past = iso(NOW - 3 * DAY)
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = [{ id: 'lead-1', funnel_id: F1, email: 'lead@example.com', name: 'L', first_name: null, status: 'new', application_status: null, application_submitted_at: null }]
    bookings = [
      funnelRow({ id: 'past-funnel', start_time: past, end_time: past }),
      coachPageRow({ id: 'past-coachpage', start_time: past, end_time: past }),
      // A funnel booking whose email matches NO lead — already unusable before
      // coach-page bookings existed, and previously listed with lead_id null.
      funnelRow({ id: 'past-orphan', email: 'nobody@example.com', start_time: past, end_time: past }),
    ]

    const r = await call(handler, JAMAUL)
    // POST /api/leads/[leadId]/outcome is addressed BY LEAD ID, so a row with
    // lead_id null has nothing to post to and would fail on click.
    eq('only the row with a real lead is queued', outcomeIds(r.body), ['past-funnel'])
    ok('the coach-page call is held back', !outcomeIds(r.body).includes('past-coachpage'))
    ok('so is the lead-less funnel call', !outcomeIds(r.body).includes('past-orphan'))
    // Every queued row must carry a lead id — the property, not the example.
    ok('every queued row has a non-null lead_id', (r.body?.needs_outcome || []).every((x: any) => typeof x.lead_id === 'string' && x.lead_id))
    // ...and the queue is not simply empty, which would satisfy the line above.
    ok('and the queue is not empty', outcomeIds(r.body).length === 1, JSON.stringify(r.body?.needs_outcome))

    // But they DO appear on the calendar, which is the point of the change.
    funnels = []
    const cal = await call(handler, JAMAUL, { month: new Date(NOW - 3 * DAY).toISOString().slice(0, 7) })
    ok('a past coach-page call is still visible in the month view', agendaIds(cal.body).includes('past-coachpage'), JSON.stringify(agendaIds(cal.body)))
  }

  console.log('\n-- a rebooked lead leaves the recovery list --')
  {
    // REVERSED. This block used to assert the opposite, and the assertion was
    // right about the code and wrong about the product: a queue meaning "people
    // you approved who are NOT on your calendar" was listing someone who was.
    // The full rules live in tests/approvedNotBooked.test.ts; this is the seam
    // between the two changes, kept here because it is where the old decision
    // was pinned.
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = [{ id: 'lead-appr', funnel_id: F1, email: 'approved@example.com', name: 'Approved', first_name: null, status: 'new', application_status: 'qualified', application_submitted_at: iso(NOW - DAY) }]
    // The same person books through the COACH page instead of the funnel.
    bookings = [coachPageRow({ id: 'cp-rebook', email: 'approved@example.com' })]

    const r = await call(handler, JAMAUL)
    eq('they are no longer a recovery target', ((r.body?.approved_not_booked) || []).map((x: any) => x.lead_id), [])
    ok('because their call is on the calendar', agendaIds(r.body).includes('cp-rebook'))

    // The pair. Cancel the same booking and they come back — otherwise "empty"
    // above could equally mean the queue stopped working.
    bookings = [coachPageRow({ id: 'cp-rebook', email: 'approved@example.com', status: 'canceled' })]
    const afterCancel = await call(handler, JAMAUL)
    eq('and a canceled rebooking restores them', ((afterCancel.body?.approved_not_booked) || []).map((x: any) => x.lead_id), ['lead-appr'])
  }

  console.log('\n-- canceled bookings still appear nowhere --')
  {
    funnels = []
    leads = []
    // The real row, in the state production currently has it.
    bookings = [coachPageRow({ status: 'canceled' })]

    const r = await call(handler, JAMAUL)
    eq('a canceled coach-page booking is not in agenda', agendaIds(r.body), [])
    ok('and every booking query filtered on active', bookingQueries.every((u) => u.includes('status=eq.active')), JSON.stringify(bookingQueries))
  }

  console.log('\n-- the SAME defect on the dashboard: portfolio upcoming_calls --')
  {
    // Found by sweeping the class rather than fixing the reported instance.
    // portfolio.ts\u2019s upcoming-calls panel is a coach-facing list of calls and
    // was scoped funnel_id-only, exactly as the calendar was. Its two COUNT
    // queries stay funnel-scoped on purpose \u2014 they are funnel analytics.
    const { default: portfolio } = await import('../api/funnels/portfolio')

    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    leads = []
    bookings = [coachPageRow({ id: 'cp-up' }), funnelRow({ id: 'fn-up' })]

    const r = await call(portfolio, JAMAUL)
    const ids = ((r.body?.upcoming_calls) || []).map((x: any) => x.booking_id)
    ok('the coach-page call reaches the dashboard', ids.includes('cp-up'), JSON.stringify(ids))
    ok('and the funnel call still does', ids.includes('fn-up'), JSON.stringify(ids))
    eq('exactly those two', ids.slice().sort(), ['cp-up', 'fn-up'])

    // Same access-control property as the calendar, on the second surface.
    bookings = [coachPageRow({ id: 'cp-mine' }), coachPageRow({ id: 'cp-theirs', coach_user_id: OTHER_COACH })]
    const mine = await call(portfolio, JAMAUL)
    const mineIds = ((mine.body?.upcoming_calls) || []).map((x: any) => x.booking_id)
    eq('and it does not leak another coach\u2019s call', mineIds, ['cp-mine'])

    // REFINE MUST REACH BOTH ARMS. One past row per arm: whichever arm loses the
    // future-only filter leaks its past call into an "upcoming" list. With the
    // filter on one arm only this is the assertion that fails, and nothing else
    // in the suite can tell the difference.
    funnels = [{ id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }]
    bookings = [
      coachPageRow({ id: 'cp-past', start_time: iso(NOW - 3 * DAY), end_time: iso(NOW - 3 * DAY) }),
      coachPageRow({ id: 'cp-future', start_time: iso(NOW + 3 * DAY), end_time: iso(NOW + 3 * DAY) }),
      funnelRow({ id: 'fn-past', start_time: iso(NOW - 2 * DAY), end_time: iso(NOW - 2 * DAY) }),
      funnelRow({ id: 'fn-future', start_time: iso(NOW + 2 * DAY), end_time: iso(NOW + 2 * DAY) }),
    ]
    const upc = await call(portfolio, JAMAUL)
    const upcIds = ((upc.body?.upcoming_calls) || []).map((x: any) => x.booking_id)
    eq('upcoming means future on BOTH arms', upcIds.slice().sort(), ['cp-future', 'fn-future'])
    ok('no past coach-page call leaked in', !upcIds.includes('cp-past'), JSON.stringify(upcIds))
    ok('no past funnel call leaked in', !upcIds.includes('fn-past'), JSON.stringify(upcIds))

    // Zero funnels must not empty the dashboard panel either.
    funnels = []
    bookings = [coachPageRow({ id: 'cp-only' })]
    const noFunnels = await call(portfolio, JAMAUL)
    eq('a coach with no funnels still sees their call', ((noFunnels.body?.upcoming_calls) || []).map((x: any) => x.booking_id), ['cp-only'])
  }

  console.log('\n-- both surfaces read the ownership rule from ONE place --')
  {
    // The rule is duplicated the moment someone writes the second arm inline
    // again, and the two surfaces then drift. Asserted against the source so a
    // reintroduced local union fails here rather than in production.
    const { readFileSync } = await import('fs')
    for (const f of ['api/calendar/index.ts', 'api/funnels/portfolio.ts']) {
      const src = readFileSync(f, 'utf8')
      ok(`${f} imports the shared ownership rule`, /loadOwnedActiveBookings/.test(src))
      ok(`${f} does not hand-roll a coach_user_id booking scope`, !/from\('bookings'\)[\s\S]{0,200}coach_user_id/.test(src), 'inline union reintroduced')
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
