process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'

// Dynamic imports: outcome.ts -> lib/funnelNurture -> lib/email, which builds
// `new Resend(process.env.RESEND_API_KEY!)` at module scope.
import { createSessionToken } from '../lib/auth'

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
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = Date.now()

let funnels: any[] = []
let leads: any[] = []
let bookings: any[] = []
let events: any[] = []
let notes: any[] = []
let leadUpdates: any[] = []
let bookingUpdates: any[] = []
let eventInserts: any[] = []
let cancelledOutreach: string[] = []

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function ilikeParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=ilike\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  // Decode first: PostgREST percent-encodes .in() as in.%28a%2Cb%29, so the
  // param helpers below would never match the raw URL.
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) return json({ status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })

  if (url.includes('/rest/v1/funnels')) {
    const id = eqParam(url, 'id')
    const owner = eqParam(url, 'user_id')
    if (id) return json(funnels.find((f) => f.id === id) ?? null)
    return json(funnels.filter((f) => !owner || f.user_id === owner))
  }

  if (url.includes('/rest/v1/funnel_leads')) {
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      leadUpdates.push({ id, ...body })
      const row = leads.find((l) => l.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    const id = eqParam(url, 'id')
    if (id) return json(leads.find((l) => l.id === id) ?? null)
    const ids = inParam(url, 'funnel_id')
    return json(leads.filter((l) => !ids || ids.includes(l.funnel_id)))
  }

  if (url.includes('/rest/v1/bookings')) {
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      bookingUpdates.push({ id, ...body })
      const row = bookings.find((b) => b.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    const fid = eqParam(url, 'funnel_id')
    const mail = ilikeParam(url, 'email')
    const fids = inParam(url, 'funnel_id')
    return json(bookings.filter((b) =>
      (fid ? b.funnel_id === fid : true) &&
      (fids ? fids.includes(b.funnel_id) : true) &&
      (mail ? String(b.email).toLowerCase() === mail.toLowerCase() : true)
    ))
  }

  if (url.includes('/rest/v1/funnel_events')) {
    if (method === 'POST') { eventInserts.push(init?.body ? JSON.parse(String(init.body)) : {}); return json({}) }
    const types = inParam(url, 'event_type')
    const leadIds = inParam(url, 'lead_id') || (eqParam(url, 'lead_id') ? [eqParam(url, 'lead_id')!] : null)
    return json(events.filter((e) =>
      (!types || types.includes(e.event_type)) && (!leadIds || leadIds.includes(e.lead_id))
    ))
  }

  if (url.includes('/rest/v1/funnel_lead_notes')) return json(notes)
  if (url.includes('/rest/v1/funnel_email_sends')) return json([])
  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { query?: any; method?: string; body?: any; user?: string }) {
  const token = await createSessionToken(opts.user || USER)
  let status = 0, body: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { body = v; return res }, end() { return res } }
  await handler({ query: opts.query || {}, headers: { authorization: `Bearer ${token}` }, method: opts.method || 'GET', body: opts.body } as any, res)
  return { status, body }
}

function reset() {
  funnels = [
    { id: F1, user_id: USER, subdomain: 'charge-demo', problem_solution_label: 'Charge Without the Cringe', landing_page: {}, booking_questions: [{ id: 'q1', label: 'Biggest challenge?' }, { id: 'q2', label: 'Budget?' }] },
    { id: F2, user_id: USER, subdomain: 'second', problem_solution_label: null, landing_page: { headline: 'Second Funnel' }, booking_questions: [] },
    { id: 'foreign', user_id: OTHER, subdomain: 'nope', problem_solution_label: 'Not Yours', landing_page: {}, booking_questions: [] },
  ]
  leads = []; bookings = []; events = []; notes = []
  leadUpdates = []; bookingUpdates = []; eventInserts = []; cancelledOutreach = []
}

function mkLead(id: string, o: any = {}) {
  return { id, funnel_id: F1, email: `${id}@example.com`, name: null, first_name: null, phone: null,
    status: 'lead', qualification_status: 'not_applicable', application_status: null,
    application_answers: null, application_submitted_at: null, opted_in_at: null,
    nurture_pivoted: false, close_amount: null, notes: null, source: 'landing',
    created_at: iso(NOW - 10 * 24 * HOUR), ...o }
}
function mkBooking(id: string, email: string, o: any = {}) {
  return { id, funnel_id: F1, email, name: 'Booked Person', start_time: iso(NOW + 24 * HOUR),
    end_time: null, attended: null, attendance_marked_at: null, status: 'active',
    zoom_join_url: 'https://zoom.us/j/1', meeting_url: null, custom_answers: null,
    reschedule_count: 0, created_at: iso(NOW - HOUR), ...o }
}

;(async () => {
  const list: Handler = (await import('../api/contacts/index')).default
  const detail: Handler = (await import('../api/contacts/[leadId]')).default
  const outcome: Handler = (await import('../api/leads/[leadId]/outcome')).default

  console.log('\n-- stage derivation, first match wins --')
  reset()
  leads = [
    mkLead('l-lead'),
    mkLead('l-optin', { opted_in_at: iso(NOW - 3 * 24 * HOUR) }),
    mkLead('l-nurture', { opted_in_at: iso(NOW - 5 * 24 * HOUR), nurture_pivoted: true }),
    mkLead('l-booked', { opted_in_at: iso(NOW - 2 * 24 * HOUR) }),
    mkLead('l-notfit', { opted_in_at: iso(NOW - 4 * 24 * HOUR), application_status: 'disqualified', application_submitted_at: iso(NOW - 4 * 24 * HOUR) }),
    mkLead('l-won', { status: 'sold', close_amount: 1497, opted_in_at: iso(NOW - 6 * 24 * HOUR) }),
    mkLead('l-lost', { status: 'lost', opted_in_at: iso(NOW - 7 * 24 * HOUR) }),
  ]
  bookings = [mkBooking('b1', 'l-booked@example.com'), mkBooking('b2', 'l-notfit@example.com')]
  events = [{ lead_id: 'l-won', event_type: 'sold', created_at: iso(NOW - 2 * HOUR) }]
  const r1 = await call(list, {})
  const stageOf = (id: string) => r1.body?.contacts?.find((c: any) => c.lead_id === id)?.stage
  ok('200', r1.status === 200, JSON.stringify(r1.body).slice(0, 200))
  ok('lead', stageOf('l-lead') === 'lead', `got ${stageOf('l-lead')}`)
  ok('opted-in-only collapses into lead (no separate opted_in stage)', stageOf('l-optin') === 'lead', `got ${stageOf('l-optin')}`)
  ok('nurture still beats a bare opt-in', stageOf('l-nurture') === 'nurture')
  ok('booked (bookings row exists)', stageOf('l-booked') === 'booked')
  ok('not_fit beats booked', stageOf('l-notfit') === 'not_fit', `got ${stageOf('l-notfit')}`)
  ok('won beats everything', stageOf('l-won') === 'won')
  ok('lost is its own stage', stageOf('l-lost') === 'lost')
  ok('stage_counts.all = 7', r1.body?.stage_counts?.all === 7, JSON.stringify(r1.body?.stage_counts))
  ok('lead count absorbs the opted-in contact (2, not 1)', r1.body?.stage_counts?.lead === 2, JSON.stringify(r1.body?.stage_counts))
  ok('stage_counts has NO opted_in key at all', !('opted_in' in (r1.body?.stage_counts || {})), JSON.stringify(r1.body?.stage_counts))
  ok('final stage set is exactly the six', JSON.stringify(Object.keys(r1.body?.stage_counts || {})) === JSON.stringify(['all', 'lead', 'booked', 'won', 'nurture', 'not_fit', 'lost']), JSON.stringify(Object.keys(r1.body?.stage_counts || {})))
  ok('stage_counts per stage', r1.body?.stage_counts?.won === 1 && r1.body?.stage_counts?.not_fit === 1)

  console.log('\n-- last_activity labels --')
  const labelOf = (id: string) => r1.body?.contacts?.find((c: any) => c.lead_id === id)?.last_activity?.label
  ok('"Closed 2h ago" from the sold event timestamp', labelOf('l-won') === 'Closed 2h ago', `got ${labelOf('l-won')}`)
  ok('future call -> "Call <date>"', /^Call [A-Z]/.test(labelOf('l-booked') || ''), `got ${labelOf('l-booked')}`)
  ok('disqualified -> "Disqualified"', labelOf('l-notfit') === 'Disqualified')
  ok('"Opted in <date>" survives as an ACTIVITY label even with no opted_in stage', /^Opted in /.test(labelOf('l-optin') || ''), `got ${labelOf('l-optin')}`)
  ok('never opted in -> "Registered"', labelOf('l-lead') === 'Registered', `got ${labelOf('l-lead')}`)
  ok('value carries close_amount', r1.body?.contacts?.find((c: any) => c.lead_id === 'l-won')?.value === 1497)
  ok('source is the funnel name', r1.body?.contacts?.[0]?.source === 'Charge Without the Cringe')

  console.log('\n-- "Needs outcome": past call, never marked, outranks everything --')
  reset()
  leads = [mkLead('l-x', { opted_in_at: iso(NOW - 5 * 24 * HOUR) })]
  bookings = [mkBooking('b-past', 'l-x@example.com', { start_time: iso(NOW - 2 * HOUR) })]
  const r2 = await call(list, {})
  ok('label is "Needs outcome"', r2.body?.contacts?.[0]?.last_activity?.label === 'Needs outcome', `got ${r2.body?.contacts?.[0]?.last_activity?.label}`)
  ok('stage stays booked', r2.body?.contacts?.[0]?.stage === 'booked')
  ok('attended null maps to null', r2.body?.contacts?.[0]?.booking?.attended === null)

  console.log('\n-- attended maps showed/no_show -> yes/no for the wire --')
  bookings = [mkBooking('b-s', 'l-x@example.com', { start_time: iso(NOW - 3 * HOUR), attended: 'showed' })]
  const r3 = await call(list, {})
  ok('showed -> "yes"', r3.body?.contacts?.[0]?.booking?.attended === 'yes', `got ${r3.body?.contacts?.[0]?.booking?.attended}`)
  ok('no longer "Needs outcome"', r3.body?.contacts?.[0]?.last_activity?.label !== 'Needs outcome')
  bookings = [mkBooking('b-n', 'l-x@example.com', { start_time: iso(NOW - 3 * HOUR), attended: 'no_show' })]
  const r3b = await call(list, {})
  ok('no_show -> "no"', r3b.body?.contacts?.[0]?.booking?.attended === 'no')

  console.log('\n-- a canceled booking does not make a lead "booked" --')
  bookings = [mkBooking('b-c', 'l-x@example.com', { status: 'canceled' })]
  const r4 = await call(list, {})
  ok('falls back to lead', r4.body?.contacts?.[0]?.stage === 'lead', `got ${r4.body?.contacts?.[0]?.stage}`)

  console.log('\n-- booking matched case-insensitively --')
  leads = [mkLead('l-case', { email: 'Mixed.Case@Example.com' })]
  bookings = [mkBooking('b-case', 'mixed.case@example.com')]
  const r5 = await call(list, {})
  ok('matched despite case drift', r5.body?.contacts?.[0]?.stage === 'booked', `got ${r5.body?.contacts?.[0]?.stage}`)

  console.log('\n-- ownership + filters --')
  reset()
  leads = [
    mkLead('a', { funnel_id: F1, email: 'ann@example.com', name: 'Ann', opted_in_at: iso(NOW - HOUR) }),
    mkLead('b', { funnel_id: F2, email: 'bob@example.com', name: 'Bob' }),
    mkLead('c', { funnel_id: 'foreign', email: 'carol@example.com', name: 'Carol' }),
  ]
  const rAll = await call(list, {})
  ok('only the caller\'s two funnels are listed', rAll.body?.contacts?.length === 2, `got ${rAll.body?.contacts?.length}`)
  ok('foreign funnel\'s lead excluded', !rAll.body?.contacts?.some((c: any) => c.lead_id === 'c'))
  const rF2 = await call(list, { query: { funnel_id: F2 } })
  ok('funnel_id filter', rF2.body?.contacts?.length === 1 && rF2.body.contacts[0].lead_id === 'b')
  ok('F2 name falls back to landing_page.headline', rF2.body?.contacts?.[0]?.source === 'Second Funnel')
  const rForeign = await call(list, { query: { funnel_id: 'foreign' } })
  ok('filtering to an unowned funnel yields nothing, not a leak', rForeign.body?.contacts?.length === 0)
  const rQ = await call(list, { query: { q: 'ANN' } })
  ok('q searches name case-insensitively', rQ.body?.contacts?.length === 1 && rQ.body.contacts[0].lead_id === 'a')
  const rQe = await call(list, { query: { q: 'bob@ex' } })
  ok('q searches email too', rQe.body?.contacts?.length === 1 && rQe.body.contacts[0].lead_id === 'b')
  const rStage = await call(list, { query: { stage: 'lead' } })
  ok('stage filter', rStage.body?.contacts?.length === 2, `got ${rStage.body?.contacts?.length}`)
  ok('stage_counts still show the full set to switch to', rStage.body?.stage_counts?.all === 2)
  const rGone = await call(list, { query: { stage: 'opted_in' } })
  ok('stage=opted_in is now rejected, not silently empty', rGone.status === 400 && rGone.body?.field === 'stage', `got ${rGone.status} ${JSON.stringify(rGone.body)}`)
  ok('the 400 advertises the six real stages', JSON.stringify(rGone.body?.allowed) === JSON.stringify(['all', 'lead', 'booked', 'won', 'nurture', 'not_fit', 'lost']), JSON.stringify(rGone.body?.allowed))
  const rBad = await call(list, { query: { stage: 'bogus' } })
  ok('unknown stage 400s', rBad.status === 400 && rBad.body?.field === 'stage')
  const rPage = await call(list, { query: { limit: '1' } })
  ok('pagination', rPage.body?.contacts?.length === 1 && rPage.body?.page?.total === 2)

  console.log('\n-- GET /api/contacts/[leadId] --')
  reset()
  leads = [mkLead('d1', { email: 'Deep@Example.com', name: 'Deep Lead', opted_in_at: iso(NOW - 3 * 24 * HOUR),
    application_status: 'qualified', application_submitted_at: iso(NOW - 2 * 24 * HOUR),
    application_answers: { q1: 'Naming my price', q2: ['5k', '10k'] } })]
  bookings = [mkBooking('bd', 'deep@example.com', { custom_answers: [{ id: 'q1', label: 'Biggest challenge?', answer: 'Pricing' }] })]
  notes = [{ id: 'n1', body: 'Great call', created_at: iso(NOW - HOUR), author_user_id: USER }]
  const d = await call(detail, { query: { leadId: 'd1' } })
  ok('200', d.status === 200, JSON.stringify(d.body).slice(0, 200))
  ok('contact block matches list shape', d.body?.contact?.stage === 'booked' && d.body?.contact?.lead_id === 'd1')
  ok('answers rendered with question labels', d.body?.application?.[0]?.question === 'Biggest challenge?' && d.body?.application?.[0]?.answer === 'Naming my price')
  ok('array answers joined', d.body?.application?.[1]?.answer === '5k, 10k', JSON.stringify(d.body?.application))
  ok('booking present with join url', d.body?.booking?.join_url === 'https://zoom.us/j/1')
  ok('booking answers rendered', d.body?.booking?.answers?.[0]?.question === 'Biggest challenge?')
  ok('notes returned', d.body?.notes?.length === 1)
  ok('timeline has captured/opted in/application/booking', d.body?.timeline?.length >= 4, JSON.stringify(d.body?.timeline))
  ok('timeline newest first', d.body?.timeline?.[0]?.at >= d.body?.timeline?.[1]?.at)
  const dForeign = await call(detail, { query: { leadId: 'd1' }, user: OTHER })
  ok('another coach 404s (not 403 — indistinguishable from missing)', dForeign.status === 404)
  const dMissing = await call(detail, { query: { leadId: 'nope' } })
  ok('unknown lead 404s', dMissing.status === 404)

  console.log('\n-- POST outcome: won --')
  reset()
  leads = [mkLead('o1', { opted_in_at: iso(NOW - 3 * 24 * HOUR) })]
  bookings = [mkBooking('bo1', 'o1@example.com', { start_time: iso(NOW - 2 * HOUR) })]
  const w = await call(outcome, { query: { leadId: 'o1' }, method: 'POST', body: { outcome: 'won', close_amount: 1497 } })
  ok('200', w.status === 200, JSON.stringify(w.body).slice(0, 200))
  ok('status written as "sold" — what revenue rollups filter on', leadUpdates[0]?.status === 'sold', JSON.stringify(leadUpdates))
  ok('close_amount written', leadUpdates[0]?.close_amount === 1497)
  ok('sold event logged for the timeline', eventInserts.some((e) => e.event_type === 'sold'))
  ok('returns a list-shaped contact', w.body?.contact?.stage === 'won' && w.body?.contact?.value === 1497)
  ok('contact carries last_activity', !!w.body?.contact?.last_activity?.label)

  console.log('\n-- won without an amount is refused (would post $0 revenue) --')
  reset(); leads = [mkLead('o2')]
  const wNo = await call(outcome, { query: { leadId: 'o2' }, method: 'POST', body: { outcome: 'won' } })
  ok('400', wNo.status === 400 && wNo.body?.field === 'close_amount', JSON.stringify(wNo.body))
  ok('nothing written', leadUpdates.length === 0)

  console.log('\n-- POST outcome: lost --')
  reset(); leads = [mkLead('o3', { opted_in_at: iso(NOW - HOUR) })]
  const l = await call(outcome, { query: { leadId: 'o3' }, method: 'POST', body: { outcome: 'lost', notes: 'went cold' } })
  ok('200', l.status === 200)
  ok('status "lost"', leadUpdates[0]?.status === 'lost')
  ok('no close_amount set', !('close_amount' in (leadUpdates[0] || {})), JSON.stringify(leadUpdates[0]))
  ok('notes saved', leadUpdates[0]?.notes === 'went cold')
  ok('NOT logged as a sold/closed event — must not touch revenue', !eventInserts.some((e) => ['sold', 'closed'].includes(e.event_type)))
  ok('stage reads lost', l.body?.contact?.stage === 'lost')

  console.log('\n-- POST outcome: no_show --')
  reset()
  leads = [mkLead('o4', { opted_in_at: iso(NOW - 3 * 24 * HOUR) })]
  bookings = [mkBooking('bo4', 'o4@example.com', { start_time: iso(NOW - 2 * HOUR) })]
  const ns = await call(outcome, { query: { leadId: 'o4' }, method: 'POST', body: { outcome: 'no_show' } })
  ok('200', ns.status === 200, JSON.stringify(ns.body).slice(0, 200))
  ok('writes attended="no_show", the only legal value', bookingUpdates[0]?.attended === 'no_show', JSON.stringify(bookingUpdates))
  ok('stamps attendance_marked_at', !!bookingUpdates[0]?.attendance_marked_at)
  ok('lead status untouched — they still need working', leadUpdates.length === 0, JSON.stringify(leadUpdates))
  ok('response maps attended to "no"', ns.body?.contact?.booking?.attended === 'no')
  ok('no longer "Needs outcome"', ns.body?.contact?.last_activity?.label !== 'Needs outcome')

  console.log('\n-- no_show with no booking is refused --')
  reset(); leads = [mkLead('o5')]
  const nsNo = await call(outcome, { query: { leadId: 'o5' }, method: 'POST', body: { outcome: 'no_show' } })
  ok('400 no_booking', nsNo.status === 400 && nsNo.body?.error === 'no_booking')

  console.log('\n-- outcome validation + ownership --')
  reset(); leads = [mkLead('o6')]
  ok('unknown outcome 400s', (await call(outcome, { query: { leadId: 'o6' }, method: 'POST', body: { outcome: 'maybe' } })).status === 400)
  ok('unknown field 400s', (await call(outcome, { query: { leadId: 'o6' }, method: 'POST', body: { outcome: 'lost', bogus: 1 } })).status === 400)
  ok('negative amount 400s', (await call(outcome, { query: { leadId: 'o6' }, method: 'POST', body: { outcome: 'won', close_amount: -5 } })).status === 400)
  ok('another coach 404s', (await call(outcome, { query: { leadId: 'o6' }, method: 'POST', body: { outcome: 'lost' }, user: OTHER })).status === 404)
  ok('GET on the outcome route 405s', (await call(outcome, { query: { leadId: 'o6' }, method: 'GET' })).status === 405)

  console.log('\n-- empty account --')
  reset(); leads = []
  const e = await call(list, {})
  ok('200 with empty contacts', e.status === 200 && e.body?.contacts?.length === 0)
  ok('stage_counts all zero, not missing', e.body?.stage_counts?.all === 0 && e.body?.stage_counts?.won === 0, JSON.stringify(e.body?.stage_counts))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
