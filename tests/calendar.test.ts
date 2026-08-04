process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '/home/user/client-atm-api/lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const USER = 'coach-1'
const OTHER = 'coach-2'
const F1 = 'funnel-1'
const F2 = 'funnel-2'
const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

let funnels: any[] = []
let leads: any[] = []
let bookings: any[] = []
let availability: any = null

function eqParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? m[1] : null
}
function inParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => s.replace(/^"|"$/g, '')) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) return json({ status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })
  if (url.includes('/rest/v1/user_availability')) return json(availability)
  if (url.includes('/rest/v1/funnels')) {
    const owner = eqParam(url, 'user_id')
    return json(funnels.filter((f) => !owner || f.user_id === owner))
  }
  if (url.includes('/rest/v1/funnel_leads')) {
    const ids = inParam(url, 'funnel_id')
    return json(leads.filter((l) => !ids || ids.includes(l.funnel_id)))
  }
  if (url.includes('/rest/v1/bookings')) {
    const ids = inParam(url, 'funnel_id')
    const status = eqParam(url, 'status')
    return json(bookings
      .filter((b) => (!ids || ids.includes(b.funnel_id)) && (!status || b.status === status))
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))))
  }
  return json([])
}) as typeof fetch

async function call(handler: Handler, query: any = {}, user = USER) {
  const token = await createSessionToken(user)
  let status = 0, body: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { body = v; return res }, end() { return res } }
  await handler({ query, headers: { authorization: `Bearer ${token}` }, method: 'GET' } as any, res)
  return { status, body }
}

function reset() {
  funnels = [
    { id: F1, user_id: USER, subdomain: 'charge-demo', problem_solution_label: 'Charge Without the Cringe', landing_page: {} },
    { id: F2, user_id: USER, subdomain: 'second', problem_solution_label: null, landing_page: { headline: 'Second Funnel' } },
    { id: 'foreign', user_id: OTHER, subdomain: 'nope', problem_solution_label: 'Not Yours', landing_page: {} },
  ]
  leads = []; bookings = []; availability = null
}

const mkLead = (id: string, o: any = {}) => ({
  id, funnel_id: F1, email: `${id}@example.com`, name: null, first_name: null,
  status: 'lead', application_status: null, application_submitted_at: null, ...o,
})
const mkBooking = (id: string, email: string, o: any = {}) => ({
  id, funnel_id: F1, email, name: 'Booked Person', start_time: iso(NOW + DAY),
  end_time: iso(NOW + DAY + 30 * 60000), attended: null, status: 'active',
  zoom_join_url: 'https://zoom.us/j/1', meeting_url: null, ...o,
})

;(async () => {
  const cal: Handler = (await import('/home/user/client-atm-api/api/calendar/index')).default

  console.log('\n-- needs_outcome: past call, nothing recorded --')
  reset()
  leads = [mkLead('l1'), mkLead('l2'), mkLead('l3')]
  bookings = [
    mkBooking('b-past', 'l1@example.com', { start_time: iso(NOW - 2 * HOUR), end_time: iso(NOW - 90 * 60000) }),
    mkBooking('b-future', 'l2@example.com'),
    mkBooking('b-marked', 'l3@example.com', { start_time: iso(NOW - 3 * HOUR), attended: 'showed' }),
  ]
  const r1 = await call(cal)
  const inQueue = (id: string) => (r1.body?.needs_outcome || []).some((x: any) => x.booking_id === id)
  ok('200', r1.status === 200, JSON.stringify(r1.body).slice(0, 200))
  ok('the unmarked past call is listed', inQueue('b-past'))
  ok('resolves lead_id through (funnel_id, email)', r1.body?.needs_outcome?.find((x: any) => x.booking_id === 'b-past')?.lead_id === 'l1')
  ok('carries funnel_name', r1.body?.needs_outcome?.[0]?.funnel_name === 'Charge Without the Cringe')
  ok('carries start/end', !!r1.body?.needs_outcome?.[0]?.start_time && !!r1.body?.needs_outcome?.[0]?.end_time)
  ok('a future call is NOT owed an outcome', !inQueue('b-future'))

  console.log('\n-- attendance is NOT the hide rule: only the DEAL decision clears it --')
  ok('marked "showed" with no win/loss recorded is STILL listed', inQueue('b-marked'), JSON.stringify(r1.body?.needs_outcome?.map((x: any) => x.booking_id)))
  leads = [mkLead('l1'), mkLead('l2'), mkLead('l3')]
  bookings = [
    mkBooking('b-showed', 'l1@example.com', { start_time: iso(NOW - 2 * HOUR), attended: 'showed' }),
    mkBooking('b-noshow', 'l2@example.com', { start_time: iso(NOW - 2 * HOUR), attended: 'no_show' }),
    mkBooking('b-unmarked', 'l3@example.com', { start_time: iso(NOW - 2 * HOUR) }),
  ]
  const rAtt = await call(cal)
  const attIds = (rAtt.body?.needs_outcome || []).map((x: any) => x.booking_id).sort()
  ok('showed + unmarked listed, no_show cleared', JSON.stringify(attIds) === JSON.stringify(['b-showed', 'b-unmarked']), JSON.stringify(attIds))
  ok('a no-show is NOT owed a deal outcome', !attIds.includes('b-noshow'))
  // And a showed call only clears once the deal itself is decided.
  leads = [mkLead('l1', { status: 'sold' }), mkLead('l2'), mkLead('l3')]
  const rAtt2 = await call(cal)
  ok('the showed call clears once it is won', !(rAtt2.body?.needs_outcome || []).some((x: any) => x.booking_id === 'b-showed'), JSON.stringify(rAtt2.body?.needs_outcome?.map((x: any) => x.booking_id)))
  leads = [mkLead('l1', { status: 'lost' }), mkLead('l2'), mkLead('l3')]
  const rAtt3 = await call(cal)
  ok('and once it is lost', !(rAtt3.body?.needs_outcome || []).some((x: any) => x.booking_id === 'b-showed'))

  console.log('\n-- the close-out loop actually clears once the deal is recorded --')
  leads = [mkLead('l1', { status: 'sold' })]
  bookings = [mkBooking('b-past', 'l1@example.com', { start_time: iso(NOW - 2 * HOUR) })]
  const r2 = await call(cal)
  ok('a won lead drops off needs_outcome even with attended still null', r2.body?.needs_outcome?.length === 0, JSON.stringify(r2.body?.needs_outcome))
  leads = [mkLead('l1', { status: 'lost' })]
  const r2b = await call(cal)
  ok('a lost lead drops off too', r2b.body?.needs_outcome?.length === 0)
  leads = [mkLead('l1', { status: 'lead' })]
  const r2c = await call(cal)
  ok('an undecided lead stays on the loop', r2c.body?.needs_outcome?.length === 1)

  console.log('\n-- most overdue first --')
  reset()
  leads = [mkLead('a'), mkLead('b'), mkLead('c')]
  bookings = [
    mkBooking('b-1d', 'a@example.com', { start_time: iso(NOW - DAY) }),
    mkBooking('b-5d', 'b@example.com', { start_time: iso(NOW - 5 * DAY) }),
    mkBooking('b-3h', 'c@example.com', { start_time: iso(NOW - 3 * HOUR) }),
  ]
  const r3 = await call(cal)
  ok('oldest unclosed call first', r3.body?.needs_outcome?.map((x: any) => x.booking_id).join(',') === 'b-5d,b-1d,b-3h', JSON.stringify(r3.body?.needs_outcome?.map((x: any) => x.booking_id)))

  console.log('\n-- approved_not_booked --')
  reset()
  leads = [
    mkLead('q-nobook', { application_status: 'qualified', application_submitted_at: iso(NOW - 2 * DAY) }),
    mkLead('q-booked', { application_status: 'qualified', application_submitted_at: iso(NOW - 3 * DAY) }),
    mkLead('q-disq', { application_status: 'disqualified', application_submitted_at: iso(NOW - DAY) }),
    mkLead('q-applied', { application_status: 'applied', application_submitted_at: iso(NOW - DAY) }),
    mkLead('q-none'),
    mkLead('q-won', { application_status: 'qualified', status: 'sold', application_submitted_at: iso(NOW - 4 * DAY) }),
  ]
  bookings = [mkBooking('bq', 'q-booked@example.com')]
  const r4 = await call(cal)
  const ids = (r4.body?.approved_not_booked || []).map((x: any) => x.lead_id)
  ok('only qualified-and-unbooked', JSON.stringify(ids) === JSON.stringify(['q-nobook']), JSON.stringify(ids))
  ok('approved_at comes from application_submitted_at', r4.body?.approved_not_booked?.[0]?.approved_at === iso(NOW - 2 * DAY))
  ok('carries funnel_name', r4.body?.approved_not_booked?.[0]?.funnel_name === 'Charge Without the Cringe')
  ok('name falls back to email when null', r4.body?.approved_not_booked?.[0]?.name === 'q-nobook@example.com')

  console.log('\n-- agenda: upcoming only by default, ascending --')
  reset()
  leads = [mkLead('x'), mkLead('y'), mkLead('z')]
  bookings = [
    mkBooking('a-3d', 'x@example.com', { start_time: iso(NOW + 3 * DAY), end_time: iso(NOW + 3 * DAY + 45 * 60000) }),
    mkBooking('a-1d', 'y@example.com', { start_time: iso(NOW + DAY) }),
    mkBooking('a-past', 'z@example.com', { start_time: iso(NOW - DAY) }),
  ]
  const r5 = await call(cal)
  ok('past call excluded from agenda', !r5.body?.agenda?.some((x: any) => x.booking_id === 'a-past'))
  ok('ascending', r5.body?.agenda?.map((x: any) => x.booking_id).join(',') === 'a-1d,a-3d', JSON.stringify(r5.body?.agenda?.map((x: any) => x.booking_id)))
  ok('duration_minutes computed', r5.body?.agenda?.find((x: any) => x.booking_id === 'a-3d')?.duration_minutes === 45)
  ok('zoom_join_url present', r5.body?.agenda?.[0]?.zoom_join_url === 'https://zoom.us/j/1')
  ok('falls back to meeting_url when zoom_join_url is null', true)
  bookings = [mkBooking('a-meet', 'x@example.com', { zoom_join_url: null, meeting_url: 'https://meet.google.com/abc' })]
  const r5b = await call(cal)
  ok('meeting_url used as the join link', r5b.body?.agenda?.[0]?.zoom_join_url === 'https://meet.google.com/abc')
  ok('null end_time -> null duration', (() => { bookings = [mkBooking('a-noend', 'x@example.com', { end_time: null })]; return true })())
  const r5c = await call(cal)
  ok('duration_minutes null when end_time is null', r5c.body?.agenda?.[0]?.duration_minutes === null)

  console.log('\n-- ?month=YYYY-MM --')
  reset()
  leads = [mkLead('m')]
  bookings = [
    mkBooking('m-early', 'm@example.com', { start_time: '2026-03-02T10:00:00.000Z' }),
    mkBooking('m-late', 'm@example.com', { start_time: '2026-03-30T10:00:00.000Z' }),
    mkBooking('m-prev', 'm@example.com', { start_time: '2026-02-27T10:00:00.000Z' }),
    mkBooking('m-next', 'm@example.com', { start_time: '2026-04-01T00:00:00.000Z' }),
  ]
  const rm = await call(cal, { month: '2026-03' })
  const mIds = (rm.body?.agenda || []).map((x: any) => x.booking_id)
  ok('exactly that month, boundaries exclusive of the next', JSON.stringify(mIds) === JSON.stringify(['m-early', 'm-late']), JSON.stringify(mIds))
  ok('month echoed back', rm.body?.month === '2026-03')
  ok('past calls INSIDE the month are included', mIds.includes('m-early'))
  const rmDec = await call(cal, { month: '2026-12' })
  ok('December rolls the year over without breaking', rmDec.status === 200 && rmDec.body?.agenda?.length === 0)
  ok('bad month 400s', (await call(cal, { month: '2026-13' })).status === 400)
  ok('malformed month 400s', (await call(cal, { month: 'March' })).status === 400)

  console.log('\n-- work queues are NOT month-scoped --')
  reset()
  leads = [mkLead('w', { application_status: 'qualified', application_submitted_at: iso(NOW - DAY) })]
  bookings = [mkBooking('w-old', 'other@example.com', { start_time: iso(NOW - 60 * DAY) })]
  leads.push(mkLead('other'))
  const rw = await call(cal, { month: '2026-03' })
  ok('an unclosed call from another month still shows in needs_outcome', rw.body?.needs_outcome?.length === 1, JSON.stringify(rw.body?.needs_outcome))
  ok('approved_not_booked unaffected by month', rw.body?.approved_not_booked?.length === 1)

  console.log('\n-- canceled bookings never appear --')
  reset()
  leads = [mkLead('c1'), mkLead('c2')]
  bookings = [
    mkBooking('c-cancel-past', 'c1@example.com', { start_time: iso(NOW - DAY), status: 'canceled' }),
    mkBooking('c-cancel-future', 'c2@example.com', { status: 'canceled' }),
  ]
  const rc = await call(cal)
  ok('not in needs_outcome', rc.body?.needs_outcome?.length === 0)
  ok('not in agenda', rc.body?.agenda?.length === 0)
  // The bookings query filters status='active', so a canceled booking never
  // occupies the "already booked" key — the lead has no live call and is
  // correctly still a recovery target.
  leads = [mkLead('c1', { application_status: 'qualified', application_submitted_at: iso(NOW - DAY) })]
  const rc2 = await call(cal)
  ok('a lead whose only booking was canceled IS still a recovery target', rc2.body?.approved_not_booked?.length === 1, JSON.stringify(rc2.body?.approved_not_booked))
  ok('...and an ACTIVE booking does take them off the list', (() => {
    bookings = [mkBooking('c-active', 'c1@example.com')]
    return true
  })())
  const rc3 = await call(cal)
  ok('active booking removes them', rc3.body?.approved_not_booked?.length === 0, JSON.stringify(rc3.body?.approved_not_booked))

  console.log('\n-- ownership --')
  reset()
  leads = [mkLead('mine', { funnel_id: F1 }), mkLead('theirs', { funnel_id: 'foreign', email: 'theirs@example.com' })]
  bookings = [
    mkBooking('b-mine', 'mine@example.com', { funnel_id: F1, start_time: iso(NOW - HOUR) }),
    mkBooking('b-theirs', 'theirs@example.com', { funnel_id: 'foreign', start_time: iso(NOW - HOUR) }),
  ]
  const ro = await call(cal)
  ok('only the caller\'s funnels', ro.body?.needs_outcome?.length === 1 && ro.body.needs_outcome[0].booking_id === 'b-mine', JSON.stringify(ro.body?.needs_outcome))
  const roOther = await call(cal, {}, OTHER)
  ok('the other coach sees only theirs', roOther.body?.needs_outcome?.length === 1 && roOther.body.needs_outcome[0].booking_id === 'b-theirs')

  console.log('\n-- funnel_name fallbacks + timezone --')
  reset()
  leads = [mkLead('f2', { funnel_id: F2, email: 'f2@example.com' })]
  bookings = [mkBooking('bf2', 'f2@example.com', { funnel_id: F2 })]
  availability = { working_hours: { timezone: 'America/Chicago' }, slot_minutes: 30, buffer_minutes: 15, booking_window_days: 14 }
  const rf = await call(cal)
  ok('falls back to landing_page.headline', rf.body?.agenda?.[0]?.funnel_name === 'Second Funnel', rf.body?.agenda?.[0]?.funnel_name)
  ok('coach timezone returned', rf.body?.timezone === 'America/Chicago', rf.body?.timezone)
  availability = null
  const rf2 = await call(cal)
  ok('defaults to UTC when unconfigured', rf2.body?.timezone === 'UTC', rf2.body?.timezone)

  console.log('\n-- empty account --')
  reset()
  const re = await call(cal, {}, 'nobody')
  ok('200 with three empty arrays', re.status === 200 && re.body?.needs_outcome?.length === 0 && re.body?.approved_not_booked?.length === 0 && re.body?.agenda?.length === 0)
  ok('timezone still present', typeof re.body?.timezone === 'string')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
