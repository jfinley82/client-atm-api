process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { projectSelect } from './support/postgrest'
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const MEMBER = 'member-1'        // beta tier -> has office_hours
const LOW_TICKET = 'lowticket-1' // $27 tier -> no office_hours
const ADMIN = 'admin-1'          // admin bypasses the capability
const T0 = Date.parse('2026-08-04T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

type EventRow = { id: string; title: string; event_type: string; starts_at: string; duration_minutes: number; created_at: string }

let users: Record<string, { membership_tier: string; role: string; status: string }> = {}
let events: EventRow[] = []
let views: Record<string, string> = {}   // user_id -> last_viewed_at
let viewWrites = 0                        // every upsert attempt, to prove no duplication
let dbError: string | null = null

function mkEvent(id: string, createdAtMs: number, o: Partial<EventRow> = {}): EventRow {
  return {
    id, title: `Event ${id}`, event_type: 'Office Hours',
    starts_at: iso(createdAtMs + 7 * 24 * 3600_000), duration_minutes: 60,
    created_at: iso(createdAtMs), ...o,
  }
}

function reset() {
  users = {
    [MEMBER]: { membership_tier: 'beta', role: 'member', status: 'active' },
    [LOW_TICKET]: { membership_tier: 'low_ticket', role: 'member', status: 'active' },
    [ADMIN]: { membership_tier: 'low_ticket', role: 'admin', status: 'active' },
  }
  events = []
  views = {}
  viewWrites = 0
  dbError = null
}

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    const id = eqParam(url, 'id')
    return json(id && users[id] ? { id, ...users[id] } : null)
  }

  if (url.includes('/rest/v1/event_calendar_views')) {
    if (method === 'POST') {
      viewWrites++
      // Real behavior: upsert on the user_id PRIMARY KEY replaces in place.
      views[body.user_id] = body.last_viewed_at
      return json({}, 201)
    }
    if (dbError) return json({ message: dbError, code: 'XX000' }, 500)
    const userId = eqParam(url, 'user_id')
    return json(userId && views[userId] ? { last_viewed_at: views[userId] } : null)
  }

  if (url.includes('/rest/v1/events')) {
    if (dbError) return json({ message: dbError, code: 'XX000' }, 500)
    // The unseen route asks for the newest created_at, limit 1.
    const sorted = [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    if (/order=created_at\.desc/.test(url)) {
      return json(sorted[0] ? { created_at: sorted[0].created_at } : null)
    }
    return json(events)
  }

  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { user?: string; method?: string } = {}) {
  const token = await createSessionToken(opts.user || MEMBER)
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  await handler({ headers: { authorization: `Bearer ${token}` }, method: opts.method || 'GET', body: undefined, query: {} } as any, res)
  return { status, body: resBody }
}

;(async () => {
  const markViewed: Handler = (await import('../api/events/mark-viewed')).default
  const unseen: Handler = (await import('../api/events/unseen')).default

  console.log('\n-- never opened the page + an event exists -> badge --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  const neverViewed = await call(unseen)
  ok('200', neverViewed.status === 200)
  ok('has_new true for a member with no view row', neverViewed.body?.has_new === true, JSON.stringify(neverViewed.body))

  console.log('\n-- no events at all -> no badge, even for a never-viewed member --')
  reset()
  const noEvents = await call(unseen)
  ok('has_new false when the calendar is empty', noEvents.body?.has_new === false)

  console.log('\n-- mark viewed, then nothing new -> no badge --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  const marked = await call(markViewed, { method: 'POST' })
  ok('mark-viewed 200s', marked.status === 200)
  ok('returns the timestamp it recorded', typeof marked.body?.last_viewed_at === 'string')
  const afterMark = await call(unseen)
  ok('has_new false right after marking', afterMark.body?.has_new === false)

  console.log('\n-- a NEW event created after the last view -> badge returns --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  await call(markViewed, { method: 'POST' })
  ok('cleared first', (await call(unseen)).body?.has_new === false)
  // Admin adds a genuinely new event: a fresh row with a later created_at.
  events.push(mkEvent('e2', Date.now() + 1000))
  ok('has_new true again after a new event is created', (await call(unseen)).body?.has_new === true)

  console.log('\n-- ADMIN EDITING AN EXISTING EVENT DOES NOT RE-BADGE --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  await call(markViewed, { method: 'POST' })
  ok('cleared', (await call(unseen)).body?.has_new === false)
  // A PATCH changes starts_at / title / duration but NEVER created_at —
  // which is exactly why the badge keys off created_at.
  events[0].starts_at = iso(T0 + 30 * 24 * 3600_000)
  events[0].title = 'Rescheduled and renamed'
  events[0].duration_minutes = 90
  ok('rescheduling does not flip has_new back on', (await call(unseen)).body?.has_new === false)
  ok('created_at untouched by the edit', events[0].created_at === iso(T0 - 3 * 24 * 3600_000))

  console.log('\n-- mark-viewed UPSERTS: repeat calls update in place, never duplicate --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  await call(markViewed, { method: 'POST' })
  await call(markViewed, { method: 'POST' })
  await call(markViewed, { method: 'POST' })
  ok('three calls attempted three writes', viewWrites === 3)
  ok('but only ONE row exists', Object.keys(views).length === 1)
  ok('and it belongs to the caller', Object.keys(views)[0] === MEMBER)

  console.log('\n-- one member marking viewed does not clear another member\'s badge --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  await call(markViewed, { method: 'POST', user: MEMBER })
  ok('the member who looked has no badge', (await call(unseen, { user: MEMBER })).body?.has_new === false)
  ok('the admin who has not looked still does', (await call(unseen, { user: ADMIN })).body?.has_new === true)
  ok('two separate view rows', Object.keys(views).length === 1 && !views[ADMIN])

  console.log('\n-- office_hours capability gate on BOTH new routes --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  const lowUnseen = await call(unseen, { user: LOW_TICKET })
  ok('low_ticket blocked from unseen', lowUnseen.status === 403 && lowUnseen.body?.error === 'upgrade_required', JSON.stringify(lowUnseen))
  const lowMark = await call(markViewed, { method: 'POST', user: LOW_TICKET })
  ok('low_ticket blocked from mark-viewed', lowMark.status === 403 && lowMark.body?.error === 'upgrade_required')
  ok('and no view row was written for them', !views[LOW_TICKET])
  const adminUnseen = await call(unseen, { user: ADMIN })
  ok('admin bypasses the capability despite a low_ticket tier', adminUnseen.status === 200)

  console.log('\n-- a database error fails closed (no un-clearable badge) --')
  reset()
  events = [mkEvent('e1', T0 - 3 * 24 * 3600_000)]
  dbError = 'connection reset'
  const broken = await call(unseen)
  ok('still 200', broken.status === 200)
  ok('has_new false rather than a badge the member cannot clear', broken.body?.has_new === false)
  dbError = null

  console.log('\n-- method guards --')
  reset()
  ok('GET on mark-viewed 405s', (await call(markViewed, { method: 'GET' })).status === 405)
  ok('POST on unseen 405s', (await call(unseen, { method: 'POST' })).status === 405)
  ok('DELETE on unseen 405s', (await call(unseen, { method: 'DELETE' })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
