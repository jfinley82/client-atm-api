// The My Business dashboard: one fan-in endpoint over five owned surfaces.
//
// THE TWO THINGS MOST LIKELY TO BE WRONG, and both are asserted against
// independently-computed totals rather than against the endpoint's own output:
//
//   1. COUNTS OVER EVERYTHING, LISTS TRUNCATED. A dashboard that counts the
//      truncated list under-reports silently as a coach grows — the defect this
//      project has already hit twice in a different costume. Every fixture below
//      deliberately holds MORE rows than any list shows.
//   2. THE SCOPING. A fan-in is where a fifth copy of an ownership rule gets
//      written. Two real coach ids, and every array checked for the other's data.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.APP_URL = 'https://app.microtrainingmethod.com'

import { projectSelect, ilikeMatches, countHeaders } from './support/postgrest'
import { createSessionToken } from '../lib/auth'
import { ATTENTION_ORDER, ATTENTION_LIMIT, CLIENT_LIST_LIMIT, LEAD_LIST_LIMIT, UPCOMING_LIMIT } from '../lib/dashboardSerializers'

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

const COACH = '5c8ba4ad-0c04-4816-9fcf-b0b988a74ae6'
const OTHER_COACH = '0728feac-931a-42dd-9d87-053eea7fd88d'
const F1 = 'funnel-1'
const F2 = 'funnel-2'
const OTHER_FUNNEL = 'funnel-other'

const DAY = 86400000
const NOW = Date.now()
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString()
const ymd = (offsetDays: number) => iso(offsetDays).slice(0, 10)

// SENTINELS. Every one of the other coach's rows carries a string that cannot
// occur in this coach's data, so a leak is caught by value rather than by count.
const OTHER_SENTINEL = 'ROBINS-PRIVATE-ROW-SENTINEL'

let tables: Record<string, any[]> = {}
let seq = 0

function reset() {
  seq = 0
  tables = {
    users: [
      { id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {}, email: 'coach@example.invalid', name: 'Jamaul Finley' },
      { id: OTHER_COACH, status: 'active', role: 'member', membership_tier: 'full', add_ons: {}, email: 'robin@example.invalid', name: 'Robin Vale' },
    ],
    funnels: [
      { id: F1, user_id: COACH, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null, status: 'live' },
      { id: F2, user_id: COACH, subdomain: 'f2', problem_solution_label: 'Consultants', landing_page: null, status: 'draft' },
      { id: OTHER_FUNNEL, user_id: OTHER_COACH, subdomain: 'other', problem_solution_label: OTHER_SENTINEL, landing_page: null, status: 'live' },
    ],
    funnel_leads: [],
    bookings: [],
    client_programs: [],
    client_program_items: [],
    client_program_session_requests: [],
    funnel_lead_notes: [],
    funnel_business_settings: [{ user_id: COACH, booking_slug: 'jamaul' }],
    saved_outputs: [],
    problem_solution_cards: [],
  }
}

const lead = (over: Record<string, any> = {}) => ({
  id: `lead-${++seq}`,
  funnel_id: F1,
  email: `person${seq}@example.invalid`,
  name: `Person ${seq}`,
  first_name: null,
  status: 'lead',
  application_status: null,
  application_submitted_at: null,
  created_at: iso(-30),
  ...over,
})

const booking = (over: Record<string, any> = {}) => ({
  id: `book-${++seq}`,
  funnel_id: null,
  coach_user_id: COACH,
  email: `person${seq}@example.invalid`,
  name: `Person ${seq}`,
  start_time: iso(3),
  end_time: iso(3),
  attended: null,
  status: 'active',
  program_id: null,
  canceled_at: null,
  ...over,
})

const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
const inParam = (url: string, key: string) => {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((x) => x.replace(/^"|"$/g, '')) : null
}
function wantsObject(init: any): boolean {
  const h = init?.headers
  const accept = h && typeof h.get === 'function' ? h.get('Accept') : h?.Accept ?? h?.accept
  return /vnd\.pgrst\.object/.test(String(accept || ''))
}
function matches(url: string, row: Record<string, any>): boolean {
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=eq\.([^&]+)/g)) {
    if (key === 'select' || key === 'order' || key === 'limit') continue
    if (String(row[key]) !== val) return false
  }
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=ilike\.([^&]+)/g)) {
    if (!ilikeMatches(val, row[key])) return false
  }
  for (const [, key] of url.matchAll(/[?&]([a-z_]+)=in\./g)) {
    const list = inParam(url, key)
    if (list && !list.includes(String(row[key]))) return false
  }
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=is\.([^&]+)/g)) {
    if (val === 'null' && row[key] !== null && row[key] !== undefined) return false
  }
  return true
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const table = tableOf(url)
  if (!table) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  tables[table] = tables[table] || []
  const rows = tables[table].filter((r) => matches(url, r))
  if (method === 'HEAD') return new Response(null, { status: 200, headers: countHeaders(url, init, rows.length) })
  const body = wantsObject(init) ? rows[0] ?? null : rows
  return new Response(JSON.stringify(projectSelect(url, body, 200)), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...countHeaders(url, init, rows.length) },
  })
}) as typeof fetch

async function call(handler: Handler, user = COACH) {
  const token = await createSessionToken(user)
  let status = 0
  let out: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { out = v; return res },
    end() { return res },
  }
  await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query: {}, body: null } as any, res)
  return { status, body: out }
}

;(async () => {
  const { default: dashboard } = await import('../api/dashboard/my-business')

  console.log('\n-- ZERO IS FIRST-CLASS: a brand new coach gets a well-formed response --')
  {
    reset()
    // No funnels either — the hardest empty case, and the one that used to make
    // coach-page bookings invisible.
    tables.funnels = tables.funnels.filter((f) => f.user_id !== COACH)
    tables.funnel_business_settings = []
    const res = await call(dashboard)

    eq('200', res.status, 200)
    // EVERY count is 0 and EVERY list is [] — asserted exhaustively rather than
    // by spot-check, because "well-formed when empty" is the whole claim.
    eq('every attention count is 0', Object.values(res.body.counts), ATTENTION_ORDER.map(() => 0))
    eq('the strip is empty, not four zeroes', res.body.attention, [])
    eq('clients', [res.body.clients.total, res.body.clients.list], [0, []])
    eq('funnels', [res.body.funnels.total, res.body.funnels.list], [0, []])
    eq('calls reconcile at zero', [res.body.calls.calls_total, res.body.calls.calls_from_funnels, res.body.calls.calls_no_funnel], [0, 0, 0])
    eq('upcoming', res.body.calls.upcoming, [])
    eq('leads', [res.body.leads.total, res.body.leads.list], [0, []])
    eq('session requests', res.body.session_requests, [])
    // NOT APPLICABLE vs NOTHING YET. A coach with no framework has not built one;
    // that is a different empty state from a coach whose programmes are done, and
    // null is how the frontend tells them apart.
    eq('method is null, not a zeroed object', res.body.method, null)
  }

  console.log('\n-- COUNTS OVER EVERYTHING, LISTS TRUNCATED --')
  {
    reset()
    // Deliberately MORE than every limit, so a count computed from the sliced
    // list reads differently from one computed from the full set.
    const LEADS = LEAD_LIST_LIMIT + 4
    const CLIENTS = CLIENT_LIST_LIMIT + 3
    const CALLS = UPCOMING_LIMIT + 3

    for (let i = 0; i < LEADS; i++) tables.funnel_leads.push(lead({ created_at: iso(-30 + i) }))
    for (let i = 0; i < CALLS; i++) tables.bookings.push(booking({ start_time: iso(1 + i) }))
    for (let i = 0; i < CLIENTS; i++) {
      const id = `prog-${i}`
      tables.client_programs.push({
        id, user_id: COACH, lead_id: null, client_name: `Client ${i}`, client_email: `c${i}@example.invalid`,
        client_timezone: null, program_name: 'The Method', total_weeks: 4, sessions_allowed: 4,
        start_date: ymd(-7), status: 'active', portal_token_version: 1, portal_last_opened_at: null,
        activated_at: iso(-7), completed_at: null,
      })
    }

    const res = await call(dashboard)

    // ASSERTED AGAINST A DIRECTLY-COUNTED TOTAL, not against the endpoint's own
    // list length — that would be the endpoint agreeing with itself.
    const leadsOwned = tables.funnel_leads.filter((l) => [F1, F2].includes(l.funnel_id)).length
    const clientsOwned = tables.client_programs.filter((p) => p.user_id === COACH).length
    const callsOwned = tables.bookings.filter((b) => b.status === 'active' && (b.coach_user_id === COACH || [F1, F2].includes(b.funnel_id))).length

    eq('lead count is the whole set', res.body.leads.total, leadsOwned)
    eq('client count is the whole set', res.body.clients.total, clientsOwned)
    eq('call count is the whole set', res.body.calls.calls_total, callsOwned)

    // And the lists are shorter than the counts, which is the point.
    eq('lead list is truncated', res.body.leads.list.length, LEAD_LIST_LIMIT)
    eq('client list is truncated', res.body.clients.list.length, CLIENT_LIST_LIMIT)
    eq('upcoming is truncated', res.body.calls.upcoming.length, UPCOMING_LIMIT)
    ok('so counts EXCEED their lists', res.body.leads.total > res.body.leads.list.length && res.body.calls.calls_total > res.body.calls.upcoming.length)
  }

  console.log('\n-- THE INVARIANT: calls_total = calls_from_funnels + calls_no_funnel --')
  {
    reset()
    tables.bookings.push(
      booking({ funnel_id: F1, coach_user_id: null }),
      booking({ funnel_id: F1, coach_user_id: null }),
      booking({ funnel_id: null, coach_user_id: COACH }),
      // Cancelled and owned: NOT counted, because loadOwnedActiveBookings filters
      // status='active'. This is the row that corrected my own measurement — the
      // predicate you measure with has to be the predicate the code uses.
      booking({ funnel_id: null, coach_user_id: COACH, status: 'canceled' })
    )
    const res = await call(dashboard)
    const c = res.body.calls
    eq('the three add up', c.calls_total, c.calls_from_funnels + c.calls_no_funnel)
    eq('two from funnels, one from none', [c.calls_from_funnels, c.calls_no_funnel], [2, 1])
    eq('and the cancelled one is absent', c.calls_total, 3)
  }

  console.log('\n-- book rate is FUNNEL-scoped; the coach total is not --')
  {
    reset()
    tables.funnel_leads.push(lead({ funnel_id: F1 }), lead({ funnel_id: F1 }), lead({ funnel_id: F1 }), lead({ funnel_id: F1 }))
    tables.bookings.push(
      booking({ funnel_id: F1, coach_user_id: null }),
      // A coach-page call. It belongs to NO funnel, so it must not move book rate.
      booking({ funnel_id: null, coach_user_id: COACH })
    )
    const res = await call(dashboard)
    const f1 = res.body.funnels.list.find((f: any) => f.id === F1)
    eq('4 leads, 1 booked on the funnel', [f1.leads, f1.booked], [4, 1])
    eq('so book rate is 25%, NOT 50%', f1.book_rate, 25)
    // The reconciliation the coach would otherwise read as a bug.
    eq('while the coach total counts both', res.body.calls.calls_total, 2)
    eq('and the remainder is carried explicitly', res.body.calls.calls_no_funnel, 1)

    // An untouched funnel is 0%, never NaN and never 100%.
    const f2 = res.body.funnels.list.find((f: any) => f.id === F2)
    eq('an empty funnel converts nobody', [f2.leads, f2.booked, f2.book_rate], [0, 0, 0])
  }

  console.log('\n-- the attention strip: non-zero only, priority order, capped --')
  {
    reset()
    // Enough to fill every slot several times over.
    tables.funnel_leads.push(
      lead({ application_status: 'qualified', application_submitted_at: iso(-9) }),
      lead({ created_at: iso(-40) })
    )
    tables.bookings.push(booking({ funnel_id: F1, coach_user_id: null, start_time: iso(-5), email: 'past@example.invalid' }))
    tables.funnel_leads.push(lead({ funnel_id: F1, email: 'past@example.invalid', status: 'booked' }))
    tables.client_programs.push({
      id: 'p-draft', user_id: COACH, lead_id: null, client_name: 'Draft Client', client_email: 'd@example.invalid',
      client_timezone: null, program_name: 'P', total_weeks: 4, sessions_allowed: 4, start_date: ymd(-7),
      status: 'draft', portal_token_version: 1, portal_last_opened_at: null, activated_at: null, completed_at: null,
    })

    const res = await call(dashboard)
    ok('at most four items', res.body.attention.length <= ATTENTION_LIMIT)
    ok('every one is non-zero', res.body.attention.every((a: any) => a.count > 0), JSON.stringify(res.body.attention))

    // PRIORITY, not insertion. The strip's order must be a subsequence of the
    // declared order — asserted against ATTENTION_ORDER rather than a literal, so
    // reordering the constant moves the test with it.
    const idx = res.body.attention.map((a: any) => ATTENTION_ORDER.indexOf(a.key))
    eq('in declared priority order', idx, [...idx].sort((a, b) => a - b))
    ok('and each carries a key the frontend can switch on', res.body.attention.every((a: any) => ATTENTION_ORDER.includes(a.key)))
  }

  console.log('\n-- SCOPING: coach A sees nothing of coach B, in EVERY array --')
  {
    reset()
    // The other coach's world, every row sentinel-marked.
    tables.funnel_leads.push(
      lead({ funnel_id: OTHER_FUNNEL, email: `${OTHER_SENTINEL}@example.invalid`, name: OTHER_SENTINEL }),
      lead({ funnel_id: F1 })
    )
    tables.bookings.push(
      booking({ funnel_id: OTHER_FUNNEL, coach_user_id: OTHER_COACH, name: OTHER_SENTINEL, email: `${OTHER_SENTINEL}@x.invalid` }),
      booking({ funnel_id: null, coach_user_id: COACH })
    )
    tables.client_programs.push({
      id: 'p-other', user_id: OTHER_COACH, lead_id: null, client_name: OTHER_SENTINEL, client_email: 'o@example.invalid',
      client_timezone: null, program_name: OTHER_SENTINEL, total_weeks: 4, sessions_allowed: 4, start_date: ymd(-7),
      status: 'active', portal_token_version: 1, portal_last_opened_at: null, activated_at: iso(-7), completed_at: null,
    })
    tables.client_program_session_requests.push({
      id: 'req-other', program_id: 'p-other', item_id: null, note: OTHER_SENTINEL,
      preferred_1: null, preferred_2: null, status: 'requested', created_at: iso(-1),
    })
    tables.saved_outputs.push({ user_id: OTHER_COACH, tool_type: 'framework', content: { frameworkName: OTHER_SENTINEL, phases: [] } })
    tables.problem_solution_cards.push({ id: 'card-other', user_id: OTHER_COACH, validated: true })

    const res = await call(dashboard)
    const wire = JSON.stringify(res.body)

    // ONE ASSERTION OVER THE WHOLE PAYLOAD, so a new array added later is covered
    // without anyone remembering to extend a list of checks.
    ok('the sentinel appears nowhere in the payload', !wire.includes(OTHER_SENTINEL), wire.slice(0, 500))
    ok('nor the other coach id', !wire.includes(OTHER_COACH))
    ok('nor their funnel id', !wire.includes(OTHER_FUNNEL))

    // POSITIVE CONTROL: this coach's own data IS present, so "no leak" cannot be
    // satisfied by an endpoint that returns nothing.
    eq('this coach sees their own lead', res.body.leads.total, 1)
    eq('and their own call', res.body.calls.calls_total, 1)
    eq('and their own two funnels', res.body.funnels.total, 2)
    eq('and no clients, since both programmes are the other coach\'s', res.body.clients.total, 0)
    eq('and no session requests', res.body.session_requests, [])
    eq('and no method, since the framework is theirs', res.body.method, null)
  }

  console.log('\n-- coach-page bookings are included wherever the number is about the COACH --')
  {
    reset()
    // The rule that has been wrong three times. Every one of these is funnel-less
    // and owned only through coach_user_id.
    tables.bookings.push(
      booking({ funnel_id: null, coach_user_id: COACH, start_time: iso(2) }),
      booking({ funnel_id: null, coach_user_id: COACH, start_time: iso(4) })
    )
    const res = await call(dashboard)
    eq('they are in the coach total', res.body.calls.calls_total, 2)
    eq('and in this week / upcoming', res.body.calls.upcoming.length, 2)
    eq('and reported as the remainder', res.body.calls.calls_no_funnel, 2)
    eq('but in NO funnel column', res.body.funnels.list.reduce((n: number, f: any) => n + f.booked, 0), 0)
  }

  console.log('\n-- no_activity: what the data can actually answer --')
  {
    reset()
    const untouched = lead({ funnel_id: F1, email: 'untouched@example.invalid' })
    const hasBooking = lead({ funnel_id: F1, email: 'booked@example.invalid' })
    const hasNote = lead({ funnel_id: F1, email: 'noted@example.invalid' })
    const applied = lead({ funnel_id: F1, email: 'applied@example.invalid', application_submitted_at: iso(-2) })
    const moved = lead({ funnel_id: F1, email: 'moved@example.invalid', status: 'booked' })
    tables.funnel_leads.push(untouched, hasBooking, hasNote, applied, moved)
    tables.bookings.push(booking({ funnel_id: F1, coach_user_id: null, email: 'booked@example.invalid' }))
    tables.funnel_lead_notes.push({ id: 'n1', lead_id: hasNote.id })

    const res = await call(dashboard)
    eq('exactly one lead has no activity', res.body.leads.no_activity, 1)
    eq('and it is the untouched one', res.body.leads.list.map((l: any) => l.email), ['untouched@example.invalid'])
  }

  console.log('\n-- method: counts derived from the real shapes, never literals --')
  {
    reset()
    tables.saved_outputs.push(
      // frameworkName, NOT name — read off a production row. Guessing `name`
      // would return null for every coach and this fixture is what says so.
      { user_id: COACH, tool_type: 'framework', content: { frameworkName: 'The Method', phases: [{ steps: [1, 2, 3] }, { steps: [1, 2] }, { steps: [1] }] } },
      // Three named slots, not an array. Two filled.
      { user_id: COACH, tool_type: 'core_offers', content: { low_ticket: {}, high_ticket: {} } }
    )
    tables.problem_solution_cards.push(
      { id: 'c1', user_id: COACH, validated: true },
      { id: 'c2', user_id: COACH, validated: true },
      { id: 'c3', user_id: COACH, validated: false }
    )
    const res = await call(dashboard)
    eq('the framework name resolves', res.body.method.framework_name, 'The Method')
    eq('3 phases, 6 steps — summed from the data', [res.body.method.phase_count, res.body.method.step_count], [3, 6])
    eq('2 of 3 offer slots filled', res.body.method.offer_count, 2)
    // Blueprints are VALIDATED problem_solution_cards, not a saved_output.
    eq('only validated blueprints count', res.body.method.blueprint_count, 2)
    eq('and the booking link is built from the slug', res.body.method.booking_url, 'https://app.microtrainingmethod.com/book/jamaul')

    // A coach with no slug gets null, not a URL with an empty segment.
    reset()
    tables.saved_outputs.push({ user_id: COACH, tool_type: 'framework', content: { frameworkName: 'X', phases: [] } })
    tables.funnel_business_settings = []
    const noSlug = await call(dashboard)
    eq('no slug -> null booking_url', noSlug.body.method.booking_url, null)
  }

  console.log('\n-- the ownership rule is imported, not restated --')
  {
    const { readFileSync } = await import('fs')
    const src = readFileSync('api/dashboard/my-business.ts', 'utf8')
    // NO NEW SCOPING PREDICATE. The two arms live in lib/coachBookings.ts and
    // this endpoint must not grow a third spelling of them.
    ok('bookings resolve through the shared helper', /loadOwnedActiveBookings/.test(src))
    ok('and the queue rules through the shared module', /from '\.\.\/\.\.\/lib\/coachQueues'/.test(src))
    ok('no inline coach_user_id booking filter', !/from\('bookings'\)[\s\S]{0,200}coach_user_id/.test(src), 'a fifth copy of the ownership rule')
    ok('funnels are scoped by user_id', /from\('funnels'\)[\s\S]{0,160}eq\('user_id', userId\)/.test(src))
    ok('programmes are scoped by user_id', /from\('client_programs'\)[\s\S]{0,120}eq\('user_id', userId\)/.test(src))
    // No funnel_events at all — the unbounded scan is not needed, not replaced.
    ok('no funnel_events query', !/from\('funnel_events'\)/.test(src))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
