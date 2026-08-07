// A rebooked call must appear ON THE CONTACT it belongs to.
//
// The person comes through the funnel and becomes a lead. Later the coach hands
// them the booking link so they can rebook without reapplying. The contact shows
// up fine — they are a lead. Their new call does not, because bookings attach to
// leads through bookingKey = (funnel_id, lower(email)) and a coach-page booking
// has funnel_id NULL. It keys as `::email`, which no lead can equal.
//
// Not "the person is missing" but "the call is missing from the person", and it
// is specifically the rebooking case the coach link exists for.
//
// The load-bearing property here is that GET /api/contacts and
// GET /api/contacts/[leadId] resolve the SAME call to the SAME contact. They
// answer the same question from different queries, which is exactly the shape
// that drifts.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'

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

const F1 = 'funnel-1'
const F2 = 'funnel-2'
const OTHER_FUNNEL = 'funnel-other'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = Date.now()
const REBOOKER = 'rebooker@example.com'

let funnels: any[] = []
let leads: any[] = []
let bookings: any[] = []
let bookingQueries: string[] = []

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}
function ilikeParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=ilike\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) return json({ status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })

  if (url.includes('/rest/v1/funnels')) {
    const owner = eqParam(url, 'user_id')
    const id = eqParam(url, 'id')
    if (id) return json(funnels.find((f) => f.id === id) ?? null)
    return json(funnels.filter((f) => f.user_id === owner))
  }

  if (url.includes('/rest/v1/funnel_leads')) {
    const id = eqParam(url, 'id')
    if (id) return json(leads.find((l) => l.id === id) ?? null)
    const ids = inParam(url, 'funnel_id')
    const email = ilikeParam(url, 'email')
    let rows = leads
    // SQL `in` never matches NULL.
    if (ids) rows = rows.filter((l) => l.funnel_id != null && ids.includes(l.funnel_id))
    if (email) rows = rows.filter((l) => String(l.email).toLowerCase() === email.toLowerCase())
    return json(rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))))
  }

  if (url.includes('/rest/v1/bookings')) {
    bookingQueries.push(url)
    const ids = inParam(url, 'funnel_id')
    const coach = eqParam(url, 'coach_user_id')
    const status = eqParam(url, 'status')
    const email = ilikeParam(url, 'email')
    let rows = bookings
    if (ids) rows = rows.filter((b) => b.funnel_id != null && ids.includes(b.funnel_id))
    if (coach) rows = rows.filter((b) => b.coach_user_id === coach)
    if (status) rows = rows.filter((b) => b.status === status)
    if (email) rows = rows.filter((b) => String(b.email).toLowerCase() === email.toLowerCase())
    return json(rows.slice().sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))))
  }

  if (url.includes('/rest/v1/funnel_lead_notes')) return json([])
  if (url.includes('/rest/v1/funnel_events')) return json([])
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

const lead = (over: Record<string, any> = {}) => ({
  id: 'lead-1',
  funnel_id: F1,
  email: REBOOKER,
  name: 'Rebooking Client',
  first_name: 'Rebooking',
  phone: null,
  status: 'new',
  qualification_status: null,
  application_status: 'qualified',
  application_answers: null,
  application_submitted_at: iso(NOW - 10 * DAY),
  opted_in_at: iso(NOW - 12 * DAY),
  nurture_pivoted: null,
  close_amount: null,
  notes: null,
  source: 'funnel',
  email_unsubscribed: null,
  created_at: iso(NOW - 12 * DAY),
  ...over,
})

const coachPageBooking = (over: Record<string, any> = {}) => ({
  id: 'cp-rebook',
  funnel_id: null,
  coach_user_id: JAMAUL,
  email: REBOOKER,
  name: 'Rebooking Client',
  start_time: iso(NOW + 4 * DAY),
  end_time: iso(NOW + 4 * DAY),
  attended: null,
  attendance_marked_at: null,
  status: 'active',
  zoom_join_url: 'https://zoom.us/j/rebook',
  meeting_url: null,
  custom_answers: null,
  reschedule_count: 0,
  created_at: iso(NOW - DAY),
  ...over,
})

const funnelBooking = (over: Record<string, any> = {}) => ({
  id: 'fn-original',
  funnel_id: F1,
  coach_user_id: null,
  email: REBOOKER,
  name: 'Rebooking Client',
  start_time: iso(NOW - 8 * DAY),
  end_time: iso(NOW - 8 * DAY),
  attended: 'showed',
  attendance_marked_at: iso(NOW - 8 * DAY),
  status: 'active',
  zoom_join_url: null,
  meeting_url: 'https://meet.google.com/orig',
  custom_answers: null,
  reschedule_count: 0,
  created_at: iso(NOW - 11 * DAY),
  ...over,
})

const contactOf = (body: any, leadId: string) => ((body && body.contacts) || []).find((c: any) => c.lead_id === leadId)

;(async () => {
  const { default: list } = await import('../api/contacts/index')
  const { default: detail } = await import('../api/contacts/[leadId]')

  const FUNNEL_ROW = { id: F1, user_id: JAMAUL, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null, booking_questions: [] }

  console.log('\n-- THE DEFECT: a rebooked call reaches its contact --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead()]
    bookings = [coachPageBooking()]

    const r = await call(list, JAMAUL)
    eq('200', r.status, 200)
    const c = contactOf(r.body, 'lead-1')
    ok('the contact exists', !!c, JSON.stringify(r.body?.contacts))
    // The whole point: the call is ON the person, not merely somewhere.
    eq('their upcoming call is attached', c?.booking?.start_time, iso(NOW + 4 * DAY))
    eq("and the stage reflects it", c?.stage, 'booked')

    // Both ownership arms were read.
    ok('a coach_user_id arm was queried', bookingQueries.some((u) => u.includes(`coach_user_id=eq.${JAMAUL}`)), JSON.stringify(bookingQueries))
    ok('a funnel_id arm was queried too', bookingQueries.some((u) => /funnel_id=in\./.test(u)))
  }

  console.log('\n-- the funnel booking still attaches exactly as before --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead()]
    bookings = [funnelBooking()]

    const c = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    eq('the original call is still there', c?.booking?.start_time, iso(NOW - 8 * DAY))
    eq('with its attendance', c?.booking?.attended, 'yes')
  }

  console.log('\n-- with both, the most recent call wins, as it always did --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead()]
    bookings = [funnelBooking(), coachPageBooking()]

    const c = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    // pickBooking takes the latest active booking. The rebooked call is newer.
    eq('the rebooked call is the one shown', c?.booking?.start_time, iso(NOW + 4 * DAY))
  }

  console.log('\n-- LIST AND DETAIL AGREE, which is the property that drifts --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead()]
    bookings = [funnelBooking(), coachPageBooking()]

    const fromList = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    const d = await call(detail, JAMAUL, { leadId: 'lead-1' })

    eq('detail is 200', d.status, 200)
    // Compared AGAINST EACH OTHER, not against a constant — the failure mode is
    // the two surfaces disagreeing, not either one being wrong in isolation.
    eq('same booking time on both surfaces', d.body?.contact?.booking?.start_time, fromList?.booking?.start_time)
    eq('same stage on both surfaces', d.body?.contact?.stage, fromList?.stage)
    eq('the detail view returns the rebooked call', d.body?.booking?.start_time, iso(NOW + 4 * DAY))

    // The timeline is built from the same set, so the rebooked call is an event.
    const bookingEvents = (d.body?.timeline || []).filter((t: any) => t.type === 'booking')
    eq('both calls appear on the timeline', bookingEvents.length, 2)
  }

  console.log('\n-- ONE CALL, ONE CONTACT when the address is a lead twice --')
  {
    // The same person opted into two funnels. Attaching the call to both would
    // show it twice and count "booked" twice in stage_counts.
    funnels = [FUNNEL_ROW, { ...FUNNEL_ROW, id: F2, problem_solution_label: 'Second' }]
    const older = lead({ id: 'lead-old', funnel_id: F1, created_at: iso(NOW - 30 * DAY) })
    const newer = lead({ id: 'lead-new', funnel_id: F2, created_at: iso(NOW - 5 * DAY) })
    leads = [newer, older]
    bookings = [coachPageBooking()]

    const body = (await call(list, JAMAUL)).body
    const attached = (body?.contacts || []).filter((c: any) => c.booking?.start_time)
    eq('exactly one contact carries the call', attached.length, 1)
    eq('and it is the most recently created lead', attached[0]?.lead_id, 'lead-new')
    eq('booked is counted once', body?.stage_counts?.booked, 1)

    // The detail view must pick the SAME owner, or the two disagree about which
    // contact the call belongs to.
    const dNew = await call(detail, JAMAUL, { leadId: 'lead-new' })
    const dOld = await call(detail, JAMAUL, { leadId: 'lead-old' })
    ok('detail agrees the newer lead owns it', dNew.body?.booking?.start_time === iso(NOW + 4 * DAY), JSON.stringify(dNew.body?.booking))
    eq('and the older lead has no call', dOld.body?.booking, null)
  }

  console.log('\n-- a FUNNEL booking stays inside its own funnel --')
  {
    // The email-only match is for funnel-less bookings ONLY. Routing funnel
    // bookings through it too would bleed a call across funnels: the same person
    // is a lead in both, so the call would land on whichever lead is newest
    // rather than on the funnel it was actually booked through.
    //
    // Nothing else in this file can tell the difference, because everywhere else
    // the funnel booking's own lead is also the newest one.
    funnels = [FUNNEL_ROW, { ...FUNNEL_ROW, id: F2, problem_solution_label: 'Second' }]
    const inF1 = lead({ id: 'lead-f1', funnel_id: F1, created_at: iso(NOW - 30 * DAY) })
    const inF2 = lead({ id: 'lead-f2', funnel_id: F2, created_at: iso(NOW - 5 * DAY) })
    leads = [inF2, inF1]
    // Booked through funnel F1, by the OLDER lead. F2's lead is newer, so an
    // email-only match would hand it to the wrong contact.
    bookings = [funnelBooking({ funnel_id: F1 })]

    const body = (await call(list, JAMAUL)).body
    const f1 = contactOf(body, 'lead-f1')
    const f2 = contactOf(body, 'lead-f2')
    eq('the call is on the funnel it came through', f1?.booking?.start_time, iso(NOW - 8 * DAY))
    eq('and not on the other funnel\u2019s contact', f2?.booking?.start_time, null)
    eq('booked is counted once', body?.stage_counts?.booked, 1)
  }

  console.log('\n-- ownership: another coach’s call never attaches --')
  {
    funnels = [FUNNEL_ROW, { ...FUNNEL_ROW, id: OTHER_FUNNEL, user_id: OTHER_COACH }]
    leads = [lead()]
    // Same address, same shape, same time — only the owning coach differs, so
    // only ownership can separate them.
    bookings = [coachPageBooking({ id: 'cp-theirs', coach_user_id: OTHER_COACH })]

    const c = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    ok('the contact is present', !!c)
    eq('but carries no call', c?.booking?.start_time, null)
    eq('and is not staged as booked', c?.stage, 'lead')

    const d = await call(detail, JAMAUL, { leadId: 'lead-1' })
    eq('detail agrees there is no call', d.body?.booking, null)
  }

  console.log('\n-- a canceled rebooking does not make the contact booked --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead()]
    bookings = [coachPageBooking({ status: 'canceled' })]

    const c = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    eq('no active call', c?.booking?.start_time, null)
    ok('not staged as booked', c?.stage !== 'booked', c?.stage)

    // But the canceled call is still an EVENT on the detail timeline, which is
    // why the read is status:'any' rather than active-only.
    const d = await call(detail, JAMAUL, { leadId: 'lead-1' })
    const events = (d.body?.timeline || []).filter((t: any) => t.type === 'booking')
    eq('the cancellation still shows on the timeline', events.map((e: any) => e.label), ['Call canceled'])
  }

  console.log('\n-- case drift between the opt-in row and the booking form --')
  {
    funnels = [FUNNEL_ROW]
    leads = [lead({ email: 'ReBooker@Example.com' })]
    bookings = [coachPageBooking({ email: 'rebooker@EXAMPLE.com' })]

    const c = contactOf((await call(list, JAMAUL)).body, 'lead-1')
    eq('the call still attaches', c?.booking?.start_time, iso(NOW + 4 * DAY))
    const d = await call(detail, JAMAUL, { leadId: 'lead-1' })
    eq('and the detail view agrees', d.body?.booking?.start_time, iso(NOW + 4 * DAY))
  }

  console.log('\n-- a coach with no funnels has no CONTACTS, and that is correct --')
  {
    // Unlike the calendar: this list is built from funnel_leads, and a
    // coach-page booking creates no lead. Empty is the honest answer.
    funnels = []
    leads = []
    bookings = [coachPageBooking()]

    const r = await call(list, JAMAUL)
    eq('200 with an empty list', r.status, 200)
    eq('no contacts', r.body?.contacts, [])
  }

  console.log('\n-- both contacts surfaces read the rule from ONE place --')
  {
    const { readFileSync } = await import('fs')
    for (const f of ['api/contacts/index.ts', 'api/contacts/[leadId].ts']) {
      const src = readFileSync(f, 'utf8')
      ok(`${f} uses the shared booking index`, /buildBookingIndex/.test(src))
      ok(`${f} uses the shared ownership union`, /loadOwnedActiveBookings/.test(src))
      ok(`${f} does not scope bookings on funnel_id alone`, !/from\('bookings'\)/.test(src), 'inline booking read reintroduced')
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
