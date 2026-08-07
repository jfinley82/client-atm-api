// Programme mail and the reminder queue.
//
// THERE IS NO CRON. Every reminder is a Resend message scheduled on write and
// retracted with a cancel, so the queue is the thing that remembers — which
// makes "the queue matches the plan" a property that has to hold across every
// edit that moves a date, not a thing that gets recomputed later.
//
// The timezone block is the one that matters most. A reminder is 09:00 in the
// CLIENT's zone, and a literal UTC hour is right for half the year.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.APP_URL = 'https://app.microtrainingmethod.com'

import { projectSelect } from './support/postgrest'
import { checkWrite, applyDefaults, CLIENT_PROGRAM_CONSTRAINTS, PG_UNIQUE_VIOLATION } from './support/pgConstraints'
import { createSessionToken } from '../lib/auth'
import { signProgramToken } from '../lib/funnelLeadToken'
import { derivedDueDate } from '../lib/clientProgramPlan'

// REMINDER_HOUR is NOT imported at the top. lib/clientProgramEmail pulls in
// lib/email, which constructs `new Resend(process.env.RESEND_API_KEY!)` at
// module scope — and ES imports are hoisted above this file's own env
// assignments, so a static import here throws before the first assertion runs.
// Reached through await import() inside the IIFE, like every other test that
// touches the mail path.
let REMINDER_HOUR = 9

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
const CLIENT_EMAIL = 'dana@example.invalid'
const PROGRAM = 'program-one'
const ZONE = 'America/Los_Angeles'

const DAY = 24 * 60 * 60 * 1000
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const TODAY_MS = Date.parse(`${ymd(Date.now())}T00:00:00Z`)

/**
 * The next occurrence of a month/day, always in the future.
 *
 * A literal '2026-07-15' would pass this year and silently become a past date
 * next year, at which point the reminder is skipped for being too close and the
 * whole block reports green while asserting nothing.
 */
function nextOccurrence(month: number, day: number): string {
  const year = new Date(TODAY_MS).getUTCFullYear()
  for (const y of [year, year + 1, year + 2]) {
    const ms = Date.UTC(y, month - 1, day)
    if (ms > TODAY_MS + 40 * DAY) return ymd(ms)
  }
  return ymd(TODAY_MS + 200 * DAY)
}

// One in PDT (UTC-7), one in PST (UTC-8). Same wall clock, same zone, different
// offset — which is the only pair that can tell a DST-aware conversion from a
// stored constant.
const SUMMER_DUE = nextOccurrence(7, 15)
const WINTER_DUE = nextOccurrence(1, 15)

/**
 * THE INDEPENDENT PREDICATE. Reads an instant back out in a named zone with
 * Intl directly, never through zonedInstant — the rule and its check must not
 * be the same function, or mutating the rule moves both and the test passes
 * while the bug runs.
 */
function wallClockIn(iso: string, zone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) }
}

const dayBefore = (d: string) => ymd(Date.parse(`${d}T00:00:00Z`) - DAY)

let tables: Record<string, any[]> = {}
let sends: any[] = []
let cancels: string[] = []
let seq = 0

const START = ymd(TODAY_MS - 8 * DAY)

function program(over: Record<string, any> = {}) {
  return {
    id: PROGRAM,
    user_id: COACH,
    lead_id: null,
    client_name: 'Dana Mercer',
    client_email: CLIENT_EMAIL,
    client_timezone: ZONE,
    program_name: 'The Method',
    program_snapshot: {},
    total_weeks: 3,
    sessions_allowed: 4,
    start_date: START,
    status: 'active',
    portal_token_version: 1,
    portal_last_opened_at: null,
    activated_at: new Date(TODAY_MS - 8 * DAY).toISOString(),
    completed_at: null,
    ...over,
  }
}

function item(over: Record<string, any> = {}) {
  return {
    id: `item-${++seq}`,
    program_id: PROGRAM,
    kind: 'task',
    sequence_position: 1,
    source_week: 1,
    sort_order: 1,
    title: 'A task',
    detail: null,
    phase_name: 'Foundations',
    due_date: null,
    due_date_source: 'derived',
    status: 'pending',
    completed_at: null,
    completed_by: null,
    reminder_message_id: null,
    ...over,
  }
}

function reset(programOver: Record<string, any> = {}) {
  seq = 0
  sends = []
  cancels = []
  tables = {
    users: [
      { id: COACH, name: 'Jamaul Finley', email: 'coach@example.invalid', status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
      { id: OTHER_COACH, name: 'Robin Vale', email: 'robin@example.invalid', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} },
    ],
    funnel_business_settings: [{ user_id: COACH, business_name: 'Mercer Coaching', brand_primary_color: '#ff00aa' }],
    user_availability: [],
    client_programs: [program(programOver)],
    client_program_items: [],
    client_program_notes: [],
    client_program_session_requests: [],
    bookings: [],
    funnel_leads: [],
    funnels: [],
    funnel_email_sends: [],
    saved_outputs: [],
  }
}

const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
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
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=is\.([^&]+)/g)) {
    if (val === 'null' && row[key] !== null && row[key] !== undefined) return false
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

  if (url.includes('api.resend.com/emails')) {
    if (/\/emails\/[^/]+\/cancel/.test(url) || (method === 'POST' && /\/emails\/[^/]+$/.test(url))) {
      cancels.push(url.split('/emails/')[1].replace(/\/cancel.*$/, ''))
      return json({ id: 'canceled' })
    }
    sends.push(body)
    return json({ id: `msg-${sends.length}` })
  }

  const table = tableOf(url)
  if (!table) return json([])
  tables[table] = tables[table] || []

  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body]
    const staged: any[] = []
    for (const raw of rows) {
      const constraints = CLIENT_PROGRAM_CONSTRAINTS[table]
      const row = applyDefaults({ id: raw.id ?? `${table}-${++seq}`, ...raw }, constraints)
      if (constraints) {
        const violation = checkWrite(table, row, constraints, [...tables[table], ...staged], tables)
        if (violation) return json(violation, violation.code === PG_UNIQUE_VIOLATION ? 409 : 400)
      }
      staged.push(row)
    }
    tables[table].push(...staged)
    return json(wantsObject(init) ? staged[0] ?? null : staged)
  }
  if (method === 'PATCH') {
    const hit = tables[table].filter((r) => matches(url, r))
    for (const r of hit) Object.assign(r, body)
    return json(wantsObject(init) ? hit[0] ?? null : hit)
  }
  if (method === 'DELETE') {
    const before = tables[table].length
    tables[table] = tables[table].filter((r) => !matches(url, r))
    return json(new Array(before - tables[table].length).fill({}))
  }
  const rows = tables[table].filter((r) => matches(url, r))
  return json(wantsObject(init) ? rows[0] ?? null : rows)
}) as typeof fetch

async function coach(handler: Handler, opts: { method?: string; query?: Record<string, string>; body?: unknown; user?: string } = {}) {
  const token = await createSessionToken(opts.user || COACH)
  let status = 0
  let out: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { out = v; return res },
    end() { return res },
  }
  await handler(
    { method: opts.method || 'GET', headers: { authorization: `Bearer ${token}` }, query: opts.query || {}, body: opts.body ?? null } as any,
    res
  )
  return { status, body: out }
}

async function client(handler: Handler, opts: { method?: string; token?: string; body?: unknown } = {}) {
  let status = 0
  let out: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { out = v; return res },
    end() { return res },
  }
  await handler(
    { method: opts.method || 'GET', headers: {}, query: opts.token === undefined ? {} : { t: opts.token }, body: opts.body ?? null } as any,
    res
  )
  return { status, body: out }
}

const kindsSent = () => sends.map((s) => (s?.tags || []).find((t: any) => t.name === 'kind')?.value).filter(Boolean)
const scheduledFor = (subjectFragment: string) =>
  sends.find((s) => String(s?.subject || '').includes(subjectFragment))?.scheduled_at ?? null

;(async () => {
  ;({ REMINDER_HOUR } = await import('../lib/clientProgramEmail'))

  const { default: send } = await import('../api/client-programs/[id]/send')
  const { default: programRoute } = await import('../api/client-programs/[id]')
  const { default: itemRoute } = await import('../api/client-programs/[id]/items/[itemId]')
  const { default: itemsRoute } = await import('../api/client-programs/[id]/items/index')
  const { default: clientItem } = await import('../api/client/program/item')
  const { default: portal } = await import('../api/client/program')
  const { default: sessionRequest } = await import('../api/client/program/session-request')
  const { default: confirmRequest } = await import('../api/client-programs/[id]/requests/[requestId]')

  const q = { id: PROGRAM }

  console.log('\n-- §12.26: 09:00 in the CLIENT zone, on both sides of the DST boundary --')
  {
    reset()
    tables.client_program_items.push(item({ id: 'summer', kind: 'milestone', title: 'Summer task', due_date: SUMMER_DUE }))
    tables.client_program_items.push(item({ id: 'winter', kind: 'milestone', sequence_position: 2, title: 'Winter task', due_date: WINTER_DUE }))
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'paused' } })
    reset()
    tables.client_program_items.push(item({ id: 'summer', kind: 'milestone', title: 'Summer task', due_date: SUMMER_DUE }))
    tables.client_program_items.push(item({ id: 'winter', kind: 'milestone', sequence_position: 2, title: 'Winter task', due_date: WINTER_DUE }))
    // Force a re-sync of every row without touching a date.
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'paused' } })
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'active' } })

    const summerAt = scheduledFor('Summer task')
    const winterAt = scheduledFor('Winter task')
    ok('both were scheduled', !!summerAt && !!winterAt, JSON.stringify({ summerAt, winterAt }))

    // READ BACK IN THE ZONE, with Intl directly. Not compared against a literal
    // instant, because that is the assertion that passes today and goes red at
    // the boundary — which is the failure this test exists to prevent.
    const s = wallClockIn(summerAt, ZONE)
    const w = wallClockIn(winterAt, ZONE)
    eq('summer reads 09:00 local', [s.hour, s.minute], [REMINDER_HOUR, 0])
    eq('winter reads 09:00 local', [w.hour, w.minute], [REMINDER_HOUR, 0])
    eq('summer lands the day BEFORE the due date', s.date, dayBefore(SUMMER_DUE))
    eq('winter too', w.date, dayBefore(WINTER_DUE))

    // THE DISCRIMINATING ASSERTION. Everything is held constant except the date,
    // so the only thing that can make these two UTC hours differ is a conversion
    // that consulted the zone at the instant being scheduled. A stored offset,
    // a literal, or a fixed '16:00Z' makes them equal and fails here.
    const utcHour = (iso: string) => new Date(iso).getUTCHours()
    ok(
      'the same wall clock is a DIFFERENT UTC hour in the two seasons',
      utcHour(summerAt) !== utcHour(winterAt),
      `both ${utcHour(summerAt)}:00Z — the offset was not resolved per instant`
    )
    eq('summer is UTC-7 (PDT)', (utcHour(summerAt) - REMINDER_HOUR + 24) % 24, 7)
    eq('winter is UTC-8 (PST)', (utcHour(winterAt) - REMINDER_HOUR + 24) % 24, 8)
  }

  console.log('\n-- a null zone means UTC, visibly, rather than a guess --')
  {
    reset({ client_timezone: null })
    tables.client_program_items.push(item({ id: 'x', kind: 'milestone', title: 'Zoneless', due_date: SUMMER_DUE }))
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'paused' } })
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'active' } })
    const at = scheduledFor('Zoneless')
    ok('scheduled', !!at)
    eq('09:00 UTC', new Date(at).getUTCHours(), REMINDER_HOUR)
    eq('on the day before', at.slice(0, 10), dayBefore(SUMMER_DUE))
  }

  console.log('\n-- §12.27: a draft sends nothing, and send flips both --')
  {
    reset({ status: 'draft' })
    // ADDED THROUGH THE REAL ROUTE, not pushed into the fixture. The claim is
    // that creating an item on a draft queues nothing, and a row placed straight
    // into the table never reaches the code that would have queued it — the
    // assertion would be about the fixture and would pass with the rule deleted.
    const added = await coach(itemsRoute, {
      method: 'POST',
      query: q,
      body: { kind: 'milestone', sequence_position: 1, title: 'First', due_date: SUMMER_DUE },
    })
    eq('the item is created', added.status, 201)
    const createdId = added.body?.item?.id

    eq('nothing has been mailed', sends.length, 0)
    eq('and no reminder id was stored', tables.client_program_items.find((i: any) => i.id === createdId)?.reminder_message_id ?? null, null)
    eq('and the portal link does not resolve', (await client(portal, { token: signProgramToken(PROGRAM, 1) })).status, 404)

    const sent = await coach(send, { method: 'POST', query: q })
    eq('send succeeds', sent.status, 200)
    ok('program_welcome went out', kindsSent().includes('program_welcome'), JSON.stringify(kindsSent()))
    ok('and the reminder was queued with it', kindsSent().includes('program_item_due'), JSON.stringify(kindsSent()))
    eq('the welcome went to the client', sends[0]?.to, CLIENT_EMAIL)
    ok('carrying the portal link', String(sends[0]?.html || '').includes('/p/'))
    eq('and now the link resolves', (await client(portal, { token: signProgramToken(PROGRAM, 1) })).status, 200)

    // The id is STORED, or the reminder can never be retracted.
    const row = tables.client_program_items.find((i: any) => i.id === createdId)
    ok('the message id was stored on the item', typeof row.reminder_message_id === 'string' && row.reminder_message_id.length > 0)
  }

  console.log('\n-- §12.10: completing an item cancels its reminder and nulls the column --')
  {
    reset()
    tables.client_program_items.push(item({ id: 'i1', kind: 'milestone', title: 'First', due_date: SUMMER_DUE, reminder_message_id: 'queued-1' }))

    await coach(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'i1' }, body: { status: 'completed' } })
    eq('cancelled at Resend, by the STORED id', cancels, ['queued-1'])
    const row = tables.client_program_items.find((i: any) => i.id === 'i1')
    eq('and the column is null', row.reminder_message_id, null)
    eq('nothing was re-queued for a completed item', kindsSent().filter((k) => k === 'program_item_due').length, 0)

    // Un-ticking starts it again — the same call, the opposite direction.
    cancels = []
    await coach(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'i1' }, body: { status: 'pending' } })
    const back = tables.client_program_items.find((i: any) => i.id === 'i1')
    ok('a fresh reminder is queued', typeof back.reminder_message_id === 'string' && back.reminder_message_id !== 'queued-1')
  }

  console.log('\n-- the CLIENT ticking it does the same thing --')
  {
    reset()
    tables.client_program_items.push(item({ id: 'i1', kind: 'milestone', title: 'First', due_date: SUMMER_DUE, reminder_message_id: 'queued-1' }))
    await client(clientItem, { method: 'POST', token: signProgramToken(PROGRAM, 1), body: { item_id: 'i1', status: 'completed' } })
    eq('cancelled', cancels, ['queued-1'])
    eq('and nulled', tables.client_program_items.find((i: any) => i.id === 'i1').reminder_message_id, null)
  }

  console.log('\n-- §12.9/§12.32: moving start_date moves derived reminders and leaves manual ones --')
  {
    reset()
    tables.client_program_items.push(
      item({ id: 'derived-1', kind: 'milestone', sequence_position: 1, title: 'Derived', due_date: derivedDueDate(START, 1), reminder_message_id: 'old-derived' }),
      item({ id: 'manual-1', kind: 'milestone', sequence_position: 2, title: 'Manual', due_date: SUMMER_DUE, due_date_source: 'manual', reminder_message_id: 'old-manual' })
    )

    const newStart = ymd(TODAY_MS + 14 * DAY)
    const moved = await coach(programRoute, { method: 'PATCH', query: q, body: { start_date: newStart } })
    eq('the move succeeds', moved.status, 200)

    const d = tables.client_program_items.find((i: any) => i.id === 'derived-1')
    const m = tables.client_program_items.find((i: any) => i.id === 'manual-1')

    eq('the derived date moved', d.due_date, derivedDueDate(newStart, 1))
    eq('the manual date did NOT', m.due_date, SUMMER_DUE)

    // ONLY the derived row's message comes off the queue. Cancelling the manual
    // one would be churn on a reminder that is still correct — and a message id
    // that changes for an item nothing happened to is indistinguishable from one
    // that changed because something did.
    eq('only the derived reminder was cancelled', cancels, ['old-derived'])
    ok('and it was replaced', typeof d.reminder_message_id === 'string' && d.reminder_message_id !== 'old-derived')
    eq('the manual one is untouched', m.reminder_message_id, 'old-manual')
  }

  console.log('\n-- a paused programme goes quiet, and resuming brings it back --')
  {
    reset()
    tables.client_program_items.push(item({ id: 'i1', kind: 'milestone', title: 'First', due_date: SUMMER_DUE, reminder_message_id: 'queued-1' }))

    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'paused' } })
    eq('the queued reminder is cancelled', cancels, ['queued-1'])
    eq('and the column is null', tables.client_program_items[0].reminder_message_id, null)
    eq('nothing was re-queued while paused', kindsSent().filter((k) => k === 'program_item_due').length, 0)

    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'active' } })
    ok('resuming re-queues it', typeof tables.client_program_items[0].reminder_message_id === 'string')
    eq('one reminder, not two', kindsSent().filter((k) => k === 'program_item_due').length, 1)
  }

  console.log('\n-- a due date in the past queues nothing rather than mailing immediately --')
  {
    reset()
    // Due yesterday: the reminder instant is two days ago. A "due tomorrow"
    // email arriving for something already overdue is worse than no email.
    tables.client_program_items.push(item({ id: 'i1', kind: 'milestone', title: 'Overdue', due_date: ymd(TODAY_MS - DAY) }))
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'paused' } })
    await coach(programRoute, { method: 'PATCH', query: q, body: { status: 'active' } })
    eq('nothing queued', kindsSent().filter((k) => k === 'program_item_due').length, 0)
    eq('and the column stays null', tables.client_program_items[0].reminder_message_id, null)
  }

  console.log('\n-- the session letters: to the client on confirm and decline, to the COACH on request --')
  {
    reset()
    tables.client_program_items.push(item({ id: 'm1', kind: 'milestone', title: 'Week 1 check-in call', due_date: SUMMER_DUE }))

    const filed = await client(sessionRequest, { method: 'POST', token: signProgramToken(PROGRAM, 1), body: { item_id: 'm1', preferred_1: 'Tue am' } })
    eq('the request is filed', filed.status, 201)
    // MTM writing to a member about their client — not their business writing to
    // them in their own name.
    eq('the coach was notified', sends.length, 1)
    eq('at their own address', sends[0]?.to, 'coach@example.invalid')
    ok('from MTM, not the coach brand', String(sends[0]?.from || '').includes('Micro-Training Method'), sends[0]?.from)
    ok('naming the milestone they asked about', String(sends[0]?.html || '').includes('Week 1 check-in call'))

    const startIso = new Date(TODAY_MS + 30 * DAY + 21 * 60 * 60 * 1000).toISOString()
    sends = []
    await coach(confirmRequest, {
      method: 'POST',
      query: { id: PROGRAM, requestId: filed.body?.request?.id },
      body: { action: 'confirm', start_time: startIso, end_time: new Date(Date.parse(startIso) + 30 * 60 * 1000).toISOString() },
    })
    eq('the client is told', sends[0]?.to, CLIENT_EMAIL)
    ok('with the milestone title', String(sends[0]?.subject || '').includes('Week 1 check-in call'))
    // IN THE CLIENT'S ZONE. The instant is right either way; a confirmation that
    // renders it in somebody else's zone is the failure bookingTimeLabel exists
    // for, and the coach's zone is not the client's.
    ok('and the time rendered in THEIR zone', String(sends[0]?.html || '').includes(ZONE), sends[0]?.html?.slice(0, 400))

    // Decline, with the coach's reason verbatim and nothing invented when absent.
    reset()
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: null, status: 'requested', booking_id: null, decline_reason: null, note: null, preferred_1: null, preferred_2: null, created_at: new Date().toISOString(), resolved_at: null })
    await coach(confirmRequest, { method: 'POST', query: { id: PROGRAM, requestId: 'r1' }, body: { action: 'decline', decline_reason: 'I am away that week' } })
    eq('the decline reaches the client', sends[0]?.to, CLIENT_EMAIL)
    ok('carrying the reason verbatim', String(sends[0]?.html || '').includes('I am away that week'))

    reset()
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: null, status: 'requested', booking_id: null, decline_reason: null, note: null, preferred_1: null, preferred_2: null, created_at: new Date().toISOString(), resolved_at: null })
    await coach(confirmRequest, { method: 'POST', query: { id: PROGRAM, requestId: 'r1' }, body: { action: 'decline' } })
    ok('and inventing none when the coach gave none', !/conflict|busy|unavailable/i.test(String(sends[0]?.html || '')))
  }

  console.log('\n-- the coach notification honours the preference they already set --')
  {
    reset()
    tables.funnel_business_settings[0].notification_prefs = { new_booking: false }
    tables.client_program_items.push(item({ id: 'm1', kind: 'milestone', title: 'Call', due_date: SUMMER_DUE }))
    const filed = await client(sessionRequest, { method: 'POST', token: signProgramToken(PROGRAM, 1), body: { item_id: 'm1' } })
    eq('the request is still stored', filed.status, 201)
    // The request itself is not conditional on a mail preference — the coach
    // sees it on their programme page either way.
    eq('but nobody was mailed', sends.length, 0)
  }

  console.log('\n-- mail is best-effort: a Resend outage cannot fail the write --')
  {
    reset({ status: 'draft' })
    tables.client_program_items.push(item({ id: 'i1', kind: 'milestone', title: 'First', due_date: SUMMER_DUE }))
    const broken = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === 'string' ? input : input.url)
      if (url.includes('api.resend.com')) throw new Error('resend is down')
      return broken(input, init)
    }) as typeof fetch

    const sent = await coach(send, { method: 'POST', query: q })
    globalThis.fetch = broken

    eq('the programme still activated', sent.status, 200)
    eq('and the row says so', tables.client_programs[0].status, 'active')
    ok('with activated_at stamped', typeof tables.client_programs[0].activated_at === 'string')
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
