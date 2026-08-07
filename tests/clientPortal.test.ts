// The client's door — api/client/**, the first unauthenticated family that can
// write outside booking management.
//
// There is no session here and no user id. The token IS the credential and it
// names exactly ONE programme, so every guard in this file is a scoping guard:
// what the token can reach, and what it cannot. The three leak tests are the
// point (§12.6, §12.7) and the discovery-call test (§12.19) is the thing the
// whole feature exists to get right.
//
// Two REAL coach ids, because a leak between two programmes is only observable
// when there are two of them and they belong to different people.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.APP_URL = 'https://app.microtrainingmethod.com'

import { projectSelect } from './support/postgrest'
import { checkWrite, applyDefaults, CLIENT_PROGRAM_CONSTRAINTS, PG_UNIQUE_VIOLATION } from './support/pgConstraints'
import { createSessionToken } from '../lib/auth'
import { signProgramToken } from '../lib/funnelLeadToken'
import { MANAGE_CUTOFF_MS } from '../lib/bookingManage'
import { _clearRateLimitForTests } from '../lib/rateLimit'

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
const OTHER_CLIENT_EMAIL = 'sam@example.invalid'

// THE NEAR-MISS, measured against the real production URL shapes (see
// tests/brandIdentity.test.ts, which pins the same collision one surface over).
// The account photo and the brand logo share a HOST, a BUCKET and the coach's
// UID. Only the object path tells them apart, so a guard phrased as "no
// /avatars/", "no <uid>" or "no /storage/v1/object/" fails identically to no
// guard at all — and the healthy-page assertions below make that failure loud.
const STORAGE = 'https://stub.supabase.co/storage/v1/object/public'
const ACCOUNT_AVATAR = `${STORAGE}/avatars/avatars/${COACH}?v=1786022484350`
const BRAND_LOGO = `${STORAGE}/avatars/brand/${COACH}/logo?v=1786024979335`
const ACCOUNT_OBJECT = `/avatars/avatars/${COACH}`

// A note nobody but the coach may ever see. A sentence, not a word: a token
// short enough to occur by chance in brand CSS or a colour would make the
// absence assertion pass for the wrong reason.
const COACH_ONLY_SENTINEL = 'PRIVATE-NOTE-SENTINEL she is thinking about asking for a refund'
const SHARED_NOTE = 'Great work on the positioning draft this week.'

const P1 = 'program-one'
const P2 = 'program-two'

// ANCHORED TO THE DAY THE SUITE RUNS, not to a literal date.
//
// Both endpoints under test read the real clock — `current_week` from today, and
// the coach's agenda from `start_time >= now`. A fixture pinned to January 2026
// produces a programme in its final clamped week and an agenda with nothing in
// it, so half of what these tests assert would be a fact about the calendar
// rather than about the code. Offsets from today are the same fixture in June
// as in November.
const DAY = 24 * 60 * 60 * 1000
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const TODAY_MS = Date.parse(`${ymd(Date.now())}T00:00:00Z`)
// Eight days in: floor(8/7) + 1 = position 2, comfortably inside a 3-week plan.
const START = ymd(TODAY_MS - 8 * DAY)
const DUE = (position: number) => ymd(TODAY_MS - 8 * DAY + (position * 7 - 1) * DAY)
// Far enough out to be upcoming on any run, and outside MANAGE_CUTOFF_MS.
const FUTURE = new Date(TODAY_MS + 30 * DAY + 15 * 60 * 60 * 1000).toISOString()
const FUTURE_END = new Date(Date.parse(FUTURE) + 30 * 60 * 1000).toISOString()
const DISCOVERY_1 = new Date(TODAY_MS + 20 * DAY + 15 * 60 * 60 * 1000).toISOString()
const DISCOVERY_2 = new Date(TODAY_MS + 21 * DAY + 15 * 60 * 60 * 1000).toISOString()

let tables: Record<string, any[]> = {}
let sends: { to: string; subject: string; html: string }[] = []
let reads: string[] = []
let seq = 0

function program(over: Record<string, any> = {}) {
  return {
    id: P1,
    user_id: COACH,
    lead_id: null,
    client_name: 'Dana Mercer',
    client_email: CLIENT_EMAIL,
    client_timezone: 'America/Los_Angeles',
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
    program_id: P1,
    kind: 'task',
    sequence_position: 1,
    source_week: 1,
    sort_order: 1,
    title: 'A task',
    detail: null,
    phase_name: 'Foundations',
    due_date: DUE(1),
    due_date_source: 'derived',
    status: 'pending',
    completed_at: null,
    completed_by: null,
    reminder_message_id: null,
    ...over,
  }
}

function reset() {
  seq = 0
  sends = []
  reads = []
  // The buckets are module scope, so the recovery block below — which drives the
  // same endpoint from the same (absent) IP a dozen times — would start getting
  // throttled halfway through and report "mailed nobody" as a pass.
  _clearRateLimitForTests()
  tables = {
    users: [
      { id: COACH, name: 'Jamaul Finley', email: 'coach@example.invalid', status: 'active', role: 'admin', membership_tier: 'full', add_ons: {}, avatar_url: ACCOUNT_AVATAR },
      { id: OTHER_COACH, name: 'Robin Vale', email: 'robin@example.invalid', status: 'active', role: 'member', membership_tier: 'full', add_ons: {}, avatar_url: null },
    ],
    funnel_business_settings: [
      { user_id: COACH, business_name: 'Mercer Coaching', logo_url: BRAND_LOGO, brand_primary_color: '#ff00aa', brand_secondary_color: '#6dd80e', theme_mode: 'dark' },
      { user_id: OTHER_COACH, business_name: 'Vale Studio', logo_url: null, brand_primary_color: '#123456' },
    ],
    client_programs: [program(), program({ id: P2, user_id: OTHER_COACH, client_name: 'Sam Okafor', client_email: OTHER_CLIENT_EMAIL })],
    client_program_items: [
      item({ id: 'w1', kind: 'week', sequence_position: 1, sort_order: 0, title: 'Week 1 — Get clear', due_date: null }),
      item({ id: 'm1', kind: 'milestone', sequence_position: 1, sort_order: 1, title: 'Name the problem', due_date: DUE(1) }),
      item({ id: 'w2', kind: 'week', sequence_position: 2, sort_order: 0, title: 'Week 2 — Build', due_date: null }),
      item({ id: 't2', kind: 'task', sequence_position: 2, sort_order: 1, title: 'Draft the offer', due_date: DUE(2) }),
      item({ id: 'm2', kind: 'milestone', sequence_position: 2, sort_order: 2, title: 'Week 2 check-in call', due_date: DUE(2) }),
      item({ id: 'w3', kind: 'week', sequence_position: 3, sort_order: 0, title: 'Week 3 — Ship', due_date: null, phase_name: 'Launch' }),
      item({ id: 'm3', kind: 'milestone', sequence_position: 3, sort_order: 1, title: 'Publish it', due_date: DUE(3), phase_name: 'Launch' }),
      // The OTHER coach's programme. Every "did it leak" assertion below has a
      // real second programme to leak from.
      item({ id: 'other-item', program_id: P2, kind: 'task', title: "Robin's private task", due_date: DUE(1) }),
      // A MILESTONE on the other programme, so the ownership check is the only
      // thing that can reject it. Pointing the session-request test at
      // `other-item` instead would have it refused for being a task — a second
      // guard answering first, and the ownership check never exercised.
      item({ id: 'other-milestone', program_id: P2, kind: 'milestone', title: "Robin's check-in", due_date: DUE(2) }),
    ],
    client_program_notes: [
      { id: 'n-private', program_id: P1, body: COACH_ONLY_SENTINEL, visibility: 'coach_only', created_at: new Date(TODAY_MS - 7 * DAY).toISOString() },
      { id: 'n-shared', program_id: P1, body: SHARED_NOTE, visibility: 'coach_and_client', created_at: new Date(TODAY_MS - 6 * DAY).toISOString() },
    ],
    client_program_session_requests: [],
    bookings: [],
    funnel_leads: [],
    funnels: [],
    funnel_email_sends: [],
    user_availability: [],
  }
}

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

// `ilike` IS A PATTERN. Modelled as one here on purpose: a stub that compared
// the value literally would accept an unescaped `%` from the resend endpoint and
// report a clean bill of health on the exact input that matches every row.
function ilikeMatches(pattern: string, value: unknown): boolean {
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[++i]
      if (next !== undefined) rx += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    if (ch === '%') rx += '.*'
    else if (ch === '_') rx += '.'
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${rx}$`, 'i').test(String(value ?? ''))
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
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.resend.com/emails')) {
    if (method === 'POST') {
      sends.push({ to: String(body?.to), subject: String(body?.subject), html: String(body?.html) })
      return json({ id: `msg-${sends.length}` })
    }
    return json({ id: 'ok' })
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

  reads.push(url)
  const rows = tables[table].filter((r) => matches(url, r))
  return json(wantsObject(init) ? rows[0] ?? null : rows)
}) as typeof fetch

/**
 * A CLIENT REQUEST. No cookie, no Authorization header, no session — which is
 * the point of §12.4 and is enforced here by the shape of this helper rather
 * than by remembering not to send one.
 */
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

const tokenFor = (id: string, version: number) => signProgramToken(id, version)

;(async () => {
  const { default: portal } = await import('../api/client/program')
  const { default: clientItem } = await import('../api/client/program/item')
  const { default: sessionRequest } = await import('../api/client/program/session-request')
  const { default: withdraw } = await import('../api/client/program/session-request/withdraw')
  const { default: resend } = await import('../api/client/program/resend')
  const { default: confirmRequest } = await import('../api/client-programs/[id]/requests/[requestId]')
  const { default: calendar } = await import('../api/calendar/index')

  console.log('\n-- §12.4: the token is the whole credential --')
  {
    reset()
    const res = await client(portal, { token: tokenFor(P1, 1) })
    eq('a valid link answers 200 with no session', res.status, 200)
    eq('and it is THIS client', res.body?.program?.client_name, 'Dana Mercer')
    eq('their own week, not their coach position', res.body?.program?.current_week, 2)

    eq('no token at all is 401', (await client(portal, {})).status, 401)
    eq('a garbage token is 401', (await client(portal, { token: 'not-a-token' })).status, 401)
    // A token that verifies but names a version the row no longer carries.
    eq('a token from a bumped version is 404', (await client(portal, { token: tokenFor(P1, 1) === '' ? '' : tokenFor(P1, 2) })).status, 404)
    eq('and a token naming nothing is 404', (await client(portal, { token: tokenFor('no-such-program', 1) })).status, 404)

    // 401 vs 404 is the seam that must not blur: unsigned garbage is a bad
    // credential, a valid signature over a program the caller cannot have is a
    // missing thing. Neither ever confirms an id exists.
    for (const status of ['draft', 'paused', 'completed', 'canceled']) {
      reset()
      tables.client_programs[0].status = status
      eq(`a ${status} programme 404s`, (await client(portal, { token: tokenFor(P1, 1) })).status, 404)
    }
  }

  console.log('\n-- §12.18: revocation kills a link captured from a delivered email --')
  {
    reset()
    // CAPTURED OFF A REAL SEND, not re-minted. Re-minting after the bump would
    // sign the NEW version and prove nothing about the link already in an inbox.
    await client(resend, { method: 'POST', body: { email: CLIENT_EMAIL } })
    const mailed = /https:\/\/app\.microtrainingmethod\.com\/p\/([A-Za-z0-9_.-]+)/.exec(sends[0]?.html || '')?.[1] || ''
    ok('a link was actually captured from the email body', mailed.length > 20, `got ${JSON.stringify(mailed)}`)
    eq('and it works before revocation', (await client(portal, { token: mailed })).status, 200)

    tables.client_programs[0].portal_token_version = 2
    eq('the SAME captured link 404s after the bump', (await client(portal, { token: mailed })).status, 404)
    eq('and the newly minted one works', (await client(portal, { token: tokenFor(P1, 2) })).status, 200)
  }

  console.log('\n-- §12.6: a coach_only note never reaches the client, with a positive control --')
  {
    reset()
    const before = await client(portal, { token: tokenFor(P1, 1) })
    const wire = () => JSON.stringify(before.body)
    ok('the private note is absent from the whole payload', !wire().includes(COACH_ONLY_SENTINEL))
    // THE POSITIVE CONTROL. Without it, a payload that lost its notes array
    // entirely — or a serializer that returned {} — passes the line above.
    ok('the SHARED note is present', wire().includes(SHARED_NOTE))
    eq('exactly one note is served', before.body?.notes?.length, 1)

    // Flip the visibility and the SAME assertion must fail. This is the mutation:
    // if it still passes, the fixture cannot vary the thing the guard is about.
    reset()
    tables.client_program_notes[0].visibility = 'coach_and_client'
    const after = await client(portal, { token: tokenFor(P1, 1) })
    ok('flipped to coach_and_client, the sentinel IS served', JSON.stringify(after.body).includes(COACH_ONLY_SENTINEL))
    eq('and both notes now appear', after.body?.notes?.length, 2)

    // "STOP SELECTING, DON'T STOP USING" — asserted where it lives, because the
    // behaviour above cannot see it. The serializer filters by visibility too
    // (tests/clientProgramSerializers.test.ts pins that half), so removing this
    // `.eq` changes no output and every assertion above stays green while a
    // coach_only note sits in the process's memory. The query is the artifact
    // that has to be checked.
    reset()
    await client(portal, { token: tokenFor(P1, 1) })
    const notesQuery = reads.find((u) => u.includes('/client_program_notes'))
    ok('the notes query was issued', !!notesQuery)
    ok('and it constrains visibility in the QUERY', (notesQuery || '').includes('visibility=eq.coach_and_client'), notesQuery)
    // The bookings query is scoped the same way, by program_id and nothing else.
    const bookingsQuery = reads.find((u) => u.includes('/bookings'))
    ok('bookings are read by program_id', (bookingsQuery || '').includes(`program_id=eq.${P1}`), bookingsQuery)

    // Scoped by program too, not only by visibility.
    reset()
    tables.client_program_notes.push({ id: 'n-other', program_id: P2, body: "Robin's shared note", visibility: 'coach_and_client', created_at: new Date(TODAY_MS - 5 * DAY).toISOString() })
    const scoped = await client(portal, { token: tokenFor(P1, 1) })
    ok("another programme's client-visible note does not appear", !JSON.stringify(scoped.body).includes("Robin's shared note"))
  }

  console.log('\n-- §12.7: avatar_url never reaches the portal --')
  {
    reset()
    const res = await client(portal, { token: tokenFor(P1, 1) })
    const wire = JSON.stringify(res.body)

    // THE VALUE, not the container it sits in.
    ok('the account photo object path is absent', !wire.includes(ACCOUNT_OBJECT))
    ok('and so is the full account URL', !wire.includes(ACCOUNT_AVATAR))

    // AND A HEALTHY PAGE CONTAINS THE CONTAINER. These four lines are what make
    // the guard above testable: swap ACCOUNT_OBJECT for '/avatars/', the coach's
    // uid, or the storage host, and this block goes red — so the degraded
    // phrasing cannot be quietly accepted the day someone weakens the assertion
    // to make a legitimate logo pass.
    ok('a healthy portal DOES serve the brand logo', wire.includes(BRAND_LOGO), 'the near-miss collision is gone — re-read the fixtures')
    ok('...which shares the bucket', wire.includes('/avatars/'))
    ok('...and the coach uid', wire.includes(COACH))
    ok('...and the storage host', wire.includes('/storage/v1/object/'))

    // The column name is a SEPARATE check and must not be mistaken for the leak
    // guard: no storage URL contains the string 'avatar_url', so this is blind
    // to a leaked value and the value check above is blind to a leaked key.
    ok('no avatar_url key on the wire', !wire.includes('avatar_url'))

    // No logo at all falls through to initials, never to the account photo.
    reset()
    tables.funnel_business_settings[0].logo_url = null
    const bare = await client(portal, { token: tokenFor(P1, 1) })
    eq('no logo -> null, not a fallback', bare.body?.brand?.logo_url, null)
    eq('and initials from the business name', bare.body?.brand?.initials, 'MC')
    ok('still no account photo', !JSON.stringify(bare.body).includes(ACCOUNT_OBJECT))
  }

  console.log('\n-- the portal never carries the coach-side columns --')
  {
    reset()
    const wire = JSON.stringify((await client(portal, { token: tokenFor(P1, 1) })).body)
    for (const key of ['user_id', 'lead_id', 'program_snapshot', 'portal_token_version', 'client_email']) {
      ok(`no ${key}`, !wire.includes(key))
    }
    // By VALUE as well as by key — a serializer that renamed the field would
    // still be leaking it.
    ok('and not the coach uid inside program', !JSON.stringify((await client(portal, { token: tokenFor(P1, 1) })).body?.program).includes(COACH))
    ok('nor the client address', !wire.includes(CLIENT_EMAIL))
  }

  console.log('\n-- §12.5: a completion for another programme\'s item is refused, and changes nothing --')
  {
    reset()
    // A MILESTONE, so `kind` is not what refuses it. `other-item` is a task and
    // would have been rejected by the kind check regardless of who owns it —
    // which would leave the ownership check itself completely untested.
    const res = await client(clientItem, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'other-milestone', status: 'completed' } })
    eq('404, not 403', res.status, 404)
    // RE-READ THE ROW. A 404 that had already written would pass a status-only
    // assertion — the state is the thing under test.
    const reread = tables.client_program_items.find((i) => i.id === 'other-milestone')
    eq('the other programme item is untouched', [reread.status, reread.completed_at, reread.completed_by], ['pending', null, null])

    // Their own item works, and is stamped as theirs.
    const own = await client(clientItem, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm1', status: 'completed' } })
    eq('their own milestone is accepted', own.status, 200)
    const mine = tables.client_program_items.find((i) => i.id === 'm1')
    eq('completed_by is client, not coach', mine.completed_by, 'client')
    ok('and completed_at is stamped', typeof mine.completed_at === 'string')

    // And back again, which is the whole of what a client may do.
    await client(clientItem, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm1', status: 'pending' } })
    eq('un-ticking clears both columns', [mine.status, mine.completed_at, mine.completed_by], ['pending', null, null])

    eq('a week heading is not work', (await client(clientItem, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'w1', status: 'completed' } })).body?.error, 'invalid_item')
    eq('and an unknown status is refused', (await client(clientItem, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm1', status: 'skipped' } })).status, 400)
    // The token names the programme, so there is no second id to authorize from.
    eq('a stale token cannot write either', (await client(clientItem, { method: 'POST', token: tokenFor(P1, 9), body: { item_id: 'm1', status: 'completed' } })).status, 404)
  }

  console.log('\n-- §12.19: the discovery-call test --')
  {
    reset()
    // TWO PRE-PROGRAMME CALLS, on the SAME EMAIL as the client. Any other
    // address and the test never touches the trap it exists to pin: the whole
    // risk is that (coach, email) looks like a way to count sessions.
    tables.bookings.push(
      { id: 'disc-1', program_id: null, coach_user_id: COACH, funnel_id: null, email: CLIENT_EMAIL, name: 'Dana Mercer', start_time: DISCOVERY_1, end_time: new Date(Date.parse(DISCOVERY_1) + 30 * 60 * 1000).toISOString(), status: 'active', canceled_at: null, attended: null },
      { id: 'disc-2', program_id: null, coach_user_id: COACH, funnel_id: null, email: CLIENT_EMAIL, name: 'Dana Mercer', start_time: DISCOVERY_2, end_time: new Date(Date.parse(DISCOVERY_2) + 30 * 60 * 1000).toISOString(), status: 'active', canceled_at: null, attended: null }
    )

    const filed = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm2', preferred_1: 'Tue am' } })
    eq('the client files a request', filed.status, 201)
    const reqId = filed.body?.request?.id

    const confirmed = await coach(confirmRequest, {
      method: 'POST',
      query: { id: P1, requestId: reqId },
      body: { action: 'confirm', start_time: FUTURE, end_time: FUTURE_END },
    })
    eq('the coach confirms it', confirmed.status, 200)

    const after = await client(portal, { token: tokenFor(P1, 1) })
    eq('ONE session used', after.body?.program?.sessions_used, 1)
    eq('three remaining of four', [after.body?.program?.sessions_allowed, after.body?.program?.sessions_remaining], [4, 3])

    // AND THE DISCOVERY CALLS ARE STILL THERE. They were never filtered out of
    // the count — they were never in it — and they must also still be calls the
    // coach can see.
    const still = tables.bookings.filter((b) => b.id === 'disc-1' || b.id === 'disc-2')
    eq('both discovery bookings survive', still.length, 2)
    eq('with program_id still null', still.map((b) => b.program_id), [null, null])

    const agenda = await coach(calendar, { query: {} })
    const ids = (agenda.body?.agenda || []).map((b: any) => b.booking_id)
    ok("disc-1 is in the coach's agenda", ids.includes('disc-1'), JSON.stringify(ids))
    ok('disc-2 too', ids.includes('disc-2'), JSON.stringify(ids))
    ok('and so is the programme call', ids.length === 3, JSON.stringify(ids))
  }

  console.log('\n-- §12.20/§12.21: the allowance, and the cancellation boundary --')
  {
    reset()
    tables.client_programs[0].sessions_allowed = 1
    tables.bookings.push({ id: 'b-used', program_id: P1, coach_user_id: COACH, email: CLIENT_EMAIL, start_time: FUTURE, end_time: null, status: 'active', canceled_at: null })
    const blocked = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { preferred_1: 'any' } })
    eq('no allowance left -> 409', [blocked.status, blocked.body?.error], [409, 'no_sessions_remaining'])

    // The two sides of MANAGE_CUTOFF_MS, imported rather than restated: the
    // window a client may cancel in and the window that gives the session back
    // are the same window by construction.
    const start = Date.parse(FUTURE)
    tables.bookings[0].status = 'canceled'
    tables.bookings[0].canceled_at = new Date(start - MANAGE_CUTOFF_MS - 60_000).toISOString()
    const early = await client(portal, { token: tokenFor(P1, 1) })
    eq('cancelled outside the window returns the session', early.body?.program?.sessions_used, 0)

    tables.bookings[0].canceled_at = new Date(start - MANAGE_CUTOFF_MS + 60_000).toISOString()
    const late = await client(portal, { token: tokenFor(P1, 1) })
    eq('inside it does not', late.body?.program?.sessions_used, 1)

    // Pre-094 rows carry no timestamp, and unknown must not become "in good time".
    tables.bookings[0].canceled_at = null
    eq('a null canceled_at counts as late', (await client(portal, { token: tokenFor(P1, 1) })).body?.program?.sessions_used, 1)
  }

  console.log('\n-- §12.33: one open request at a time, and the client can take it back --')
  {
    reset()
    const first = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { note: 'first' } })
    eq('the first is created', first.status, 201)

    const second = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { note: 'second' } })
    // FROM THE INDEX, not from a pre-read. uq_session_request_open is partial on
    // status='requested' and the fake enforces it.
    eq('a second open request is refused', [second.status, second.body?.error], [409, 'request_already_open'])

    const gone = await client(withdraw, { method: 'POST', token: tokenFor(P1, 1) })
    eq('withdraw succeeds', gone.status, 200)
    const row = tables.client_program_session_requests[0]
    eq('status is withdrawn', row.status, 'withdrawn')
    ok('and resolved_at is stamped', typeof row.resolved_at === 'string')

    // THE POINT OF THE WITHDRAWAL: the partial index is freed.
    const third = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { note: 'third' } })
    eq('a fresh request is now accepted', third.status, 201)
    eq('nothing left to withdraw twice', (await client(withdraw, { method: 'POST', token: tokenFor(P2, 1) })).status, 404)

    // A CONFIRMED REQUEST IS NOT WITHDRAWABLE, and this is the only fixture that
    // can say so: withdrawing an open request cannot tell a route that filters
    // on status from one that does not. There is a booking behind a confirmed
    // request, and un-resolving it would leave the booking pointing at a request
    // that says it never happened.
    reset()
    const toConfirm = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm2' } })
    await coach(confirmRequest, {
      method: 'POST',
      query: { id: P1, requestId: toConfirm.body?.request?.id },
      body: { action: 'confirm', start_time: FUTURE, end_time: FUTURE_END },
    })
    const confirmedRow = tables.client_program_session_requests[0]
    eq('it is confirmed', confirmedRow.status, 'confirmed')
    eq('the client cannot withdraw it', (await client(withdraw, { method: 'POST', token: tokenFor(P1, 1) })).status, 404)
    eq('and it is still confirmed', confirmedRow.status, 'confirmed')
    ok('with its booking intact', tables.bookings.some((b) => b.id === confirmedRow.booking_id))
  }

  console.log('\n-- an item_id on a request is checked the same way a completion is --')
  {
    reset()
    // A MILESTONE on the other programme: kind is right, owner is not, so only
    // the ownership check can produce this answer.
    eq("another programme's milestone is refused", (await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'other-milestone' } })).body?.error, 'invalid_item')
    // And their OWN task, where kind is the only thing wrong.
    eq('a task is not a session', (await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 't2' } })).body?.error, 'invalid_item')
    eq('nothing was written', tables.client_program_session_requests.length, 0)
    eq('a milestone is', (await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm2' } })).status, 201)
  }

  console.log('\n-- §12.16/§12.17: recovery answers identically and mails only the address on file --')
  {
    reset()
    const real = await client(resend, { method: 'POST', body: { email: CLIENT_EMAIL } })
    const realSends = sends.length
    reset()
    const unknown = await client(resend, { method: 'POST', body: { email: 'nobody@example.invalid' } })
    const unknownSends = sends.length

    // BYTE-IDENTICAL, asserted by value rather than by both being "200 ok".
    eq('same status', real.status, unknown.status)
    eq('same body, exactly', JSON.stringify(real.body), JSON.stringify(unknown.body))
    eq('mail sent for the real address', realSends, 1)
    eq('and none for the unknown one', unknownSends, 0)

    // The submitted address is a LOOKUP KEY. Mailing it would make this a way to
    // have someone else's portal link delivered to your own inbox.
    reset()
    await client(resend, { method: 'POST', body: { email: CLIENT_EMAIL.toUpperCase() } })
    eq('case-insensitive lookup still finds them', sends.length, 1)
    eq('and the recipient is the STORED address', sends[0]?.to, CLIENT_EMAIL)

    // `ilike` is a pattern, and `%` from a public form matches every row.
    reset()
    const wild = await client(resend, { method: 'POST', body: { email: '%' } })
    eq('a wildcard answers the same', JSON.stringify(wild.body), JSON.stringify(real.body))
    eq('and mails nobody', sends.length, 0)
    reset()
    await client(resend, { method: 'POST', body: { email: '%@example.invalid' } })
    eq('nor does a partial wildcard', sends.length, 0)

    // A draft has never been sent; there is no link to resend.
    reset()
    tables.client_programs[0].status = 'draft'
    await client(resend, { method: 'POST', body: { email: CLIENT_EMAIL } })
    eq('a draft programme mails nothing', sends.length, 0)

    // And a client of the OTHER coach gets THEIR coach's programme, not this one.
    reset()
    await client(resend, { method: 'POST', body: { email: OTHER_CLIENT_EMAIL } })
    eq("the other client's mail goes to them", sends[0]?.to, OTHER_CLIENT_EMAIL)
    ok('and names their own programme link', (sends[0]?.html || '').includes('/p/'))
  }

  console.log('\n-- §8.3: a milestone with a confirmed call renders once, as the call --')
  {
    reset()
    const filed = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: { item_id: 'm3' } })
    await coach(confirmRequest, {
      method: 'POST',
      query: { id: P1, requestId: filed.body?.request?.id },
      body: { action: 'confirm', start_time: FUTURE, end_time: FUTURE_END },
    })
    const res = await client(portal, { token: tokenFor(P1, 1) })
    const up = res.body?.upcoming || []
    const forM3 = up.filter((e: any) => e.title === 'Publish it')
    eq('it appears exactly once', forM3.length, 1)
    eq('typed as a session', forM3[0]?.type, 'session')
    eq('with the booking instant, not the due date', forM3[0]?.at, FUTURE)

    // An ad-hoc call gets a plain label, never an invented week number.
    reset()
    const adhoc = await client(sessionRequest, { method: 'POST', token: tokenFor(P1, 1), body: {} })
    await coach(confirmRequest, {
      method: 'POST',
      query: { id: P1, requestId: adhoc.body?.request?.id },
      body: { action: 'confirm', start_time: FUTURE, end_time: FUTURE_END },
    })
    const plain = (await client(portal, { token: tokenFor(P1, 1) })).body?.upcoming?.find((e: any) => e.type === 'session')
    eq('titled from the coach first name', plain?.title, 'Call with Jamaul')
  }

  console.log('\n-- method and shape --')
  {
    reset()
    eq('portal refuses POST', (await client(portal, { method: 'POST', token: tokenFor(P1, 1) })).status, 405)
    eq('item refuses GET', (await client(clientItem, { method: 'GET', token: tokenFor(P1, 1) })).status, 405)
    eq('withdraw refuses GET', (await client(withdraw, { method: 'GET', token: tokenFor(P1, 1) })).status, 405)
    eq('resend refuses GET', (await client(resend, { method: 'GET' })).status, 405)
    // §8.1's "GETs require login only" has no client analogue: the method check
    // sits ABOVE the token check, so a wrong method is 405 and not 401.
    eq('and a wrong method with no token is still 405', (await client(portal, { method: 'DELETE' })).status, 405)
  }

  console.log('\n-- portal_last_opened_at is written, and cannot break the read --')
  {
    reset()
    const res = await client(portal, { token: tokenFor(P1, 1) })
    eq('the read succeeds', res.status, 200)
    // Fire-and-forget: give the un-awaited promise a turn to land.
    await new Promise((r) => setTimeout(r, 10))
    ok('and the timestamp was stamped', typeof tables.client_programs[0].portal_last_opened_at === 'string')
    ok('but is not on the wire', !JSON.stringify(res.body).includes('portal_last_opened_at'))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
