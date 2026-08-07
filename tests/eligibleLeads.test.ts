// closed_at is DERIVED, and it can be UNKNOWN.
//
// Two things are being pinned here, and only one of them is new code.
//
// The write already exists on BOTH paths — api/leads/[leadId]/outcome.ts and
// api/funnels/[id]/leads/[leadId].ts each insert a funnel_events row on the
// transition, and each is idempotent because it guards on the status actually
// changing. That behaviour was untested, so it is asserted here by running the
// two handlers AGAINST EACH OTHER rather than against a literal event name.
//
// eligible-leads is the new part, and its rule is that a lead whose close time
// cannot be derived is still returned, marked unknown — not filtered out, and
// not given a substitute timestamp.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
import { createSessionToken } from '../lib/auth'
import { WON_STATUSES } from '../lib/contacts'

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
const OTHER_FUNNEL = 'funnel-other'

let tables: Record<string, any[]> = {}
let seq = 0

const lead = (over: Record<string, any> = {}) => ({
  id: 'lead-1',
  funnel_id: F1,
  email: 'dana@example.invalid',
  name: 'Dana Mercer',
  first_name: 'Dana',
  phone: null,
  status: 'sold',
  qualification_status: null,
  application_status: null,
  application_answers: null,
  application_submitted_at: null,
  opted_in_at: '2026-01-01T00:00:00Z',
  nurture_pivoted: null,
  close_amount: 3000,
  notes: null,
  source: 'funnel',
  email_unsubscribed: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

function reset() {
  seq = 0
  tables = {
    users: [
      { id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
      { id: OTHER_COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
    ],
    funnels: [
      { id: F1, user_id: COACH, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null, booking_questions: [] },
      { id: OTHER_FUNNEL, user_id: OTHER_COACH, subdomain: 'other', problem_solution_label: 'Theirs', landing_page: null, booking_questions: [] },
    ],
    funnel_leads: [],
    funnel_events: [],
    client_programs: [],
    bookings: [],
    funnel_lead_notes: [],
    funnel_email_sends: [],
  }
}

const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
function wantsObject(init: any): boolean {
  const h = init?.headers
  const accept = h && typeof h.get === 'function' ? h.get('Accept') : h?.Accept ?? h?.accept
  return /vnd\.pgrst\.object/.test(String(accept || ''))
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((x) => x.replace(/^"|"$/g, '')) : null
}
function matches(url: string, row: Record<string, any>): boolean {
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=eq\.([^&]+)/g)) {
    if (['select', 'order', 'limit'].includes(key)) continue
    if (String(row[key]) !== val) return false
  }
  for (const [, key] of url.matchAll(/[?&]([a-z_]+)=in\./g)) {
    const list = inParam(url, key)
    if (list && !list.includes(String(row[key]))) return false
  }
  return true
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.resend.com')) return json({ id: 'msg' })

  const table = tableOf(url)
  if (!table) return json([])
  tables[table] = tables[table] || []

  if (method === 'POST') {
    const rows = (Array.isArray(body) ? body : [body]).map((r: any) => ({
      id: r.id ?? `${table}-${++seq}`,
      // funnel_events.created_at defaults to now(); the fixtures below set it
      // explicitly where the ordering matters.
      created_at: r.created_at ?? new Date(Date.UTC(2026, 4, 1, 12, 0, seq)).toISOString(),
      ...r,
    }))
    tables[table].push(...rows)
    return json(wantsObject(init) ? rows[0] ?? null : rows)
  }

  if (method === 'PATCH') {
    const hit = tables[table].filter((r) => matches(url, r))
    for (const r of hit) Object.assign(r, body)
    return json(wantsObject(init) ? hit[0] ?? null : hit)
  }

  const rows = tables[table].filter((r) => matches(url, r))
  return json(wantsObject(init) ? rows[0] ?? null : rows)
}) as typeof fetch

async function call(handler: Handler, opts: { method?: string; query?: Record<string, string>; body?: unknown; user?: string } = {}) {
  const token = await createSessionToken(opts.user || COACH)
  let status = 0
  let out: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { out = v; return res },
    end() { return res },
  }
  await handler({ method: opts.method || 'GET', headers: { authorization: `Bearer ${token}` }, query: opts.query || {}, body: opts.body ?? null } as any, res)
  return { status, body: out }
}

const closeEvents = () => tables.funnel_events.filter((e: any) => (WON_STATUSES as readonly string[]).includes(e.event_type))

;(async () => {
  const { default: eligible } = await import('../api/client-programs/eligible-leads')
  const { default: crmPatch } = await import('../api/funnels/[id]/leads/[leadId]')
  const { default: outcome } = await import('../api/leads/[leadId]/outcome')

  console.log('\n-- BOTH writers log the same event for the same transition --')
  {
    // Asserted AGAINST EACH OTHER, not against the literal 'sold'. If either
    // path is renamed, the two stop agreeing and this fails — a literal on both
    // sides would pass while they diverged from the query that reads them.
    reset()
    tables.funnel_leads.push(lead({ id: 'via-crm', status: 'booked' }))
    await call(crmPatch, { method: 'PATCH', query: { id: F1, leadId: 'via-crm' }, body: { status: 'sold', close_amount: 3000 } })
    const fromCrm = closeEvents().filter((e: any) => e.lead_id === 'via-crm')

    reset()
    tables.funnel_leads.push(lead({ id: 'via-outcome', status: 'booked' }))
    tables.bookings.push({ id: 'b1', funnel_id: F1, email: 'dana@example.invalid', name: 'Dana', start_time: '2026-01-10T14:00:00Z', attended: null, status: 'active', zoom_join_url: null, meeting_url: null, custom_answers: null, created_at: '2026-01-02T00:00:00Z' })
    await call(outcome, { method: 'POST', query: { leadId: 'via-outcome' }, body: { outcome: 'won', close_amount: 3000 } })
    const fromOutcome = closeEvents().filter((e: any) => e.lead_id === 'via-outcome')

    eq('the CRM path logged exactly one', fromCrm.length, 1)
    eq('the outcome path logged exactly one', fromOutcome.length, 1)
    // The comparison that matters.
    eq('and both used the SAME event_type', fromCrm[0]?.event_type, fromOutcome[0]?.event_type)
    ok('which the derivation reads', (WON_STATUSES as readonly string[]).includes(fromCrm[0]?.event_type), fromCrm[0]?.event_type)
  }

  console.log('\n-- and both are idempotent on a repeat --')
  {
    reset()
    tables.funnel_leads.push(lead({ id: 'l1', status: 'booked' }))
    await call(crmPatch, { method: 'PATCH', query: { id: F1, leadId: 'l1' }, body: { status: 'sold', close_amount: 3000 } })
    const first = closeEvents()[0]?.created_at
    await call(crmPatch, { method: 'PATCH', query: { id: F1, leadId: 'l1' }, body: { status: 'sold', close_amount: 3000 } })
    await call(crmPatch, { method: 'PATCH', query: { id: F1, leadId: 'l1' }, body: { status: 'sold', close_amount: 4000 } })
    eq('a repeated CRM PATCH logs nothing new', closeEvents().length, 1)
    eq('so min(created_at) stays the first one', closeEvents()[0]?.created_at, first)

    reset()
    tables.funnel_leads.push(lead({ id: 'l2', status: 'booked' }))
    tables.bookings.push({ id: 'b1', funnel_id: F1, email: 'dana@example.invalid', name: 'Dana', start_time: '2026-01-10T14:00:00Z', attended: null, status: 'active', zoom_join_url: null, meeting_url: null, custom_answers: null, created_at: '2026-01-02T00:00:00Z' })
    await call(outcome, { method: 'POST', query: { leadId: 'l2' }, body: { outcome: 'won', close_amount: 3000 } })
    const firstOut = closeEvents()[0]?.created_at
    await call(outcome, { method: 'POST', query: { leadId: 'l2' }, body: { outcome: 'won', close_amount: 3000 } })
    eq('a repeated outcome logs nothing new', closeEvents().length, 1)
    eq('and its timestamp is unchanged', closeEvents()[0]?.created_at, firstOut)
  }

  console.log('\n-- eligible-leads derives closed_at from the earliest event --')
  {
    reset()
    tables.funnel_leads.push(lead({ id: 'l1' }))
    tables.funnel_events.push(
      { id: 'e1', funnel_id: F1, lead_id: 'l1', event_type: 'sold', created_at: '2026-03-01T10:00:00Z' },
      // Sold, reverted, sold again. The deal closed the FIRST time; dating it
      // from the later event would date it from an edit.
      { id: 'e2', funnel_id: F1, lead_id: 'l1', event_type: 'sold', created_at: '2026-04-01T10:00:00Z' }
    )
    const r = await call(eligible)
    eq('200', r.status, 200)
    eq('one lead', r.body?.leads?.length, 1)
    eq('closed_at is the EARLIEST close event', r.body?.leads?.[0]?.closed_at, '2026-03-01T10:00:00Z')
    eq('with its amount', r.body?.leads?.[0]?.close_amount, 3000)
  }

  console.log('\n-- THE RULE: an underivable close time is UNKNOWN, not excluded --')
  {
    // A row written before either event write existed. It carries no event and
    // never will — no correctness downstream conjures a timestamp that was never
    // recorded.
    reset()
    tables.funnel_leads.push(lead({ id: 'legacy' }))

    const r = await call(eligible)
    eq('the lead is still returned', r.body?.leads?.map((l: any) => l.lead_id), ['legacy'])
    // NOT FILTERED OUT — that would hide a real customer because of a missing
    // log line.
    eq('and marked unknown', r.body?.leads?.[0]?.closed_at, null)
    // NOT SUBSTITUTED. Asserted two ways, because the obvious value check is
    // inert: `created_at` is not in the select, so swapping it in yields
    // undefined and the row still reads null. The projection makes the
    // substitution a no-op TODAY — the real risk is an edit that makes one
    // available, so that is what is guarded.
    eq('the row carries exactly five keys, none of them another timestamp',
       Object.keys(r.body.leads[0]).sort(), ['close_amount', 'closed_at', 'email', 'lead_id', 'name'])

    const { readFileSync } = await import('fs')
    const src = readFileSync('api/client-programs/eligible-leads.ts', 'utf8')
    const select = /const LEAD_COLUMNS = '([^']*)'/.exec(src)?.[1] ?? ''
    ok('the lead select is locatable', select.length > 0)
    for (const col of ['created_at', 'updated_at', 'opted_in_at', 'application_submitted_at']) {
      ok(`it does not fetch ${col}, so there is nothing to reach for`, !select.includes(col), select)
    }

    // The positive control: with an event, the same lead reports a time. Without
    // it, "closed_at is null" could equally mean the field is never populated.
    tables.funnel_events.push({ id: 'e1', funnel_id: F1, lead_id: 'legacy', event_type: 'closed', created_at: '2026-02-02T09:00:00Z' })
    const withEvent = await call(eligible)
    eq('and a derivable one reports its time', withEvent.body?.leads?.[0]?.closed_at, '2026-02-02T09:00:00Z')
  }

  console.log('\n-- known and unknown coexist, and unknowns sort last --')
  {
    reset()
    tables.funnel_leads.push(
      lead({ id: 'known-old', email: 'a@example.invalid', name: 'A' }),
      lead({ id: 'known-new', email: 'b@example.invalid', name: 'B' }),
      lead({ id: 'unknown', email: 'c@example.invalid', name: 'C' })
    )
    tables.funnel_events.push(
      { id: 'e1', funnel_id: F1, lead_id: 'known-old', event_type: 'sold', created_at: '2026-01-15T10:00:00Z' },
      { id: 'e2', funnel_id: F1, lead_id: 'known-new', event_type: 'sold', created_at: '2026-05-15T10:00:00Z' }
    )
    const r = await call(eligible)
    eq('all three are eligible', r.body?.leads?.length, 3)
    // An unknown date cannot be sorted into a timeline; putting it first would
    // imply it was the most recent close.
    eq('newest known first, unknown last', r.body?.leads?.map((l: any) => l.lead_id), ['known-new', 'known-old', 'unknown'])
    eq('and the distribution is 2 known / 1 unknown', r.body?.leads?.filter((l: any) => l.closed_at === null).length, 1)
  }

  console.log('\n-- only WON leads, and only ones not already on a program --')
  {
    reset()
    tables.funnel_leads.push(
      lead({ id: 'sold-one', status: 'sold', email: 'a@example.invalid' }),
      lead({ id: 'closed-one', status: 'closed', email: 'b@example.invalid' }),
      lead({ id: 'still-a-lead', status: 'lead', email: 'c@example.invalid' }),
      lead({ id: 'lost-one', status: 'lost', email: 'd@example.invalid' }),
      lead({ id: 'booked-one', status: 'booked', email: 'e@example.invalid' })
    )
    const all = await call(eligible)
    eq('both won statuses qualify, nothing else', all.body?.leads?.map((l: any) => l.lead_id).sort(), ['closed-one', 'sold-one'])

    // ANY program holds the lead — uq_client_programs_lead does not filter on
    // status, so a DRAFT would make the create 409 just as surely as an active
    // one. Offering it here would produce a button that always fails.
    tables.client_programs.push({ id: 'p1', user_id: COACH, lead_id: 'sold-one', status: 'draft' })
    const after = await call(eligible)
    eq('a lead already on a draft is gone', after.body?.leads?.map((l: any) => l.lead_id), ['closed-one'])
  }

  console.log('\n-- another coach’s won leads are never eligible --')
  {
    reset()
    tables.funnel_leads.push(lead({ id: 'mine' }), lead({ id: 'theirs', funnel_id: OTHER_FUNNEL, email: 'x@example.invalid' }))
    const mine = await call(eligible)
    eq('only my own', mine.body?.leads?.map((l: any) => l.lead_id), ['mine'])
    const theirs = await call(eligible, { user: OTHER_COACH })
    eq('and only theirs for them', theirs.body?.leads?.map((l: any) => l.lead_id), ['theirs'])
  }

  console.log('\n-- a name is never empty --')
  {
    reset()
    tables.funnel_leads.push(
      lead({ id: 'no-name', name: null, first_name: null, email: 'Jordan.Blake@Example.invalid' }),
      lead({ id: 'first-only', name: null, first_name: 'Sam', email: 's@example.invalid' })
    )
    const r = await call(eligible)
    const byId = Object.fromEntries((r.body?.leads || []).map((l: any) => [l.lead_id, l]))
    // Both columns null happens on an opt-in form that only asked for an
    // address; an unnamed row is one the coach cannot pick out of a list.
    eq('falls back to the address local part', byId['no-name']?.name, 'Jordan.Blake')
    eq('first_name is used when name is absent', byId['first-only']?.name, 'Sam')
    ok('and neither is empty', [byId['no-name']?.name, byId['first-only']?.name].every((n) => typeof n === 'string' && n.length > 0))
  }

  console.log('\n-- a coach with no funnels, and the method guard --')
  {
    reset()
    tables.funnels = []
    const r = await call(eligible)
    eq('empty, which is honest here', [r.status, r.body?.leads], [200, []])
    eq('405s the wrong method', (await call(eligible, { method: 'POST' })).status, 405)
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
