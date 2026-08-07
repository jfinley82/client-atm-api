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

const MEMBER = 'member-1'        // beta -> has office_hours
const OTHER = 'member-2'         // beta, used to prove per-user scoping
const LOW_TICKET = 'lowticket-1' // $27 -> no office_hours
const ADMIN = 'admin-1'          // admin bypasses the capability
const EVENT = 'evt-1'
const GHOST = 'evt-nonexistent'

let users: Record<string, { membership_tier: string; role: string; status: string }> = {}
let events: { id: string }[] = []
let rsvps: { user_id: string; event_id: string }[] = []
let deleteCalls = 0

function reset() {
  users = {
    [MEMBER]: { membership_tier: 'beta', role: 'member', status: 'active' },
    [OTHER]: { membership_tier: 'beta', role: 'member', status: 'active' },
    [LOW_TICKET]: { membership_tier: 'low_ticket', role: 'member', status: 'active' },
    [ADMIN]: { membership_tier: 'low_ticket', role: 'admin', status: 'active' },
  }
  events = [{ id: EVENT }]
  rsvps = []
  deleteCalls = 0
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

  if (url.includes('/rest/v1/events')) {
    const id = eqParam(url, 'id')
    return json(events.find((e) => e.id === id) ?? null)
  }

  if (url.includes('/rest/v1/event_rsvps')) {
    if (method === 'POST') {
      // Real behavior: upsert on the (user_id, event_id) unique constraint.
      const row = Array.isArray(body) ? body[0] : body
      if (!rsvps.some((r) => r.user_id === row.user_id && r.event_id === row.event_id)) {
        rsvps.push({ user_id: row.user_id, event_id: row.event_id })
      }
      return json({}, 201)
    }
    if (method === 'DELETE') {
      deleteCalls++
      const userId = eqParam(url, 'user_id')
      const eventId = eqParam(url, 'event_id')
      rsvps = rsvps.filter((r) => !(r.user_id === userId && r.event_id === eventId))
      return json({})
    }
    return json(rsvps)
  }

  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { user?: string; method?: string; eventId?: string } = {}) {
  const token = await createSessionToken(opts.user || MEMBER)
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  await handler(
    { headers: { authorization: `Bearer ${token}` }, method: opts.method || 'POST', body: undefined, query: { id: opts.eventId ?? EVENT } } as any,
    res
  )
  return { status, body: resBody }
}

const has = (user: string, event = EVENT) => rsvps.some((r) => r.user_id === user && r.event_id === event)

;(async () => {
  const rsvp: Handler = (await import('../api/events/[id]/rsvp')).default

  console.log('\n-- DELETE removes the caller\'s RSVP --')
  reset()
  await call(rsvp, { method: 'POST' })
  ok('RSVP recorded first', has(MEMBER))
  const cancelled = await call(rsvp, { method: 'DELETE' })
  ok('200', cancelled.status === 200)
  ok('ok:true', cancelled.body?.ok === true)
  ok('rsvpd:false echoed so the button can flip without a refetch', cancelled.body?.rsvpd === false)
  ok('row is gone', !has(MEMBER))

  console.log('\n-- cancelling when no RSVP exists is a 200 no-op, NOT a 404 --')
  reset()
  ok('no RSVP to begin with', !has(MEMBER))
  const cancelNothing = await call(rsvp, { method: 'DELETE' })
  ok('200, not 404', cancelNothing.status === 200, JSON.stringify(cancelNothing))
  ok('ok:true', cancelNothing.body?.ok === true)

  console.log('\n-- repeat DELETE (double-click / retry) stays a no-op --')
  reset()
  await call(rsvp, { method: 'POST' })
  await call(rsvp, { method: 'DELETE' })
  const second = await call(rsvp, { method: 'DELETE' })
  const third = await call(rsvp, { method: 'DELETE' })
  ok('second DELETE 200s', second.status === 200)
  ok('third DELETE 200s', third.status === 200)
  ok('all three reached the database (no client-side guard needed)', deleteCalls === 3)
  ok('still no row', !has(MEMBER))

  console.log('\n-- CANCEL THEN RE-RSVP works cleanly (no leftover unique conflict) --')
  reset()
  await call(rsvp, { method: 'POST' })
  await call(rsvp, { method: 'DELETE' })
  ok('cancelled', !has(MEMBER))
  const reRsvp = await call(rsvp, { method: 'POST' })
  ok('re-RSVP 200s', reRsvp.status === 200, JSON.stringify(reRsvp))
  ok('rsvpd:true', reRsvp.body?.rsvpd === true)
  ok('row is back', has(MEMBER))
  ok('exactly one row, not two', rsvps.filter((r) => r.user_id === MEMBER && r.event_id === EVENT).length === 1)
  // And the full cycle again, to be sure nothing accumulates.
  await call(rsvp, { method: 'DELETE' })
  await call(rsvp, { method: 'POST' })
  await call(rsvp, { method: 'DELETE' })
  await call(rsvp, { method: 'POST' })
  ok('after four more toggles, still exactly one row', rsvps.filter((r) => r.user_id === MEMBER).length === 1)

  console.log('\n-- cancelling only touches the caller\'s own row --')
  reset()
  await call(rsvp, { method: 'POST', user: MEMBER })
  await call(rsvp, { method: 'POST', user: OTHER })
  ok('both members RSVPd', has(MEMBER) && has(OTHER))
  await call(rsvp, { method: 'DELETE', user: MEMBER })
  ok('caller\'s RSVP removed', !has(MEMBER))
  ok('the other member\'s RSVP is untouched', has(OTHER))

  console.log('\n-- 404 only when the EVENT does not exist --')
  reset()
  const ghostCancel = await call(rsvp, { method: 'DELETE', eventId: GHOST })
  ok('DELETE on an unknown event 404s', ghostCancel.status === 404 && ghostCancel.body?.error === 'Event not found')
  const ghostRsvp = await call(rsvp, { method: 'POST', eventId: GHOST })
  ok('POST on an unknown event 404s too (unchanged behavior)', ghostRsvp.status === 404)

  console.log('\n-- office_hours capability gate applies to DELETE, same as POST --')
  reset()
  rsvps.push({ user_id: LOW_TICKET, event_id: EVENT })
  const lowCancel = await call(rsvp, { method: 'DELETE', user: LOW_TICKET })
  ok('low_ticket blocked from cancelling', lowCancel.status === 403 && lowCancel.body?.error === 'upgrade_required')
  ok('and their row was NOT deleted', has(LOW_TICKET))
  const adminCancel = await call(rsvp, { method: 'DELETE', user: ADMIN })
  ok('admin bypasses the capability despite a low_ticket tier', adminCancel.status === 200)

  console.log('\n-- POST behavior is unchanged by the addition --')
  reset()
  const first = await call(rsvp, { method: 'POST' })
  ok('POST 200s', first.status === 200)
  const dup = await call(rsvp, { method: 'POST' })
  ok('duplicate POST is still a harmless no-op', dup.status === 200)
  ok('and does not duplicate the row', rsvps.filter((r) => r.user_id === MEMBER).length === 1)

  console.log('\n-- method guards --')
  reset()
  ok('GET 405s', (await call(rsvp, { method: 'GET' })).status === 405)
  ok('PATCH 405s', (await call(rsvp, { method: 'PATCH' })).status === 405)
  ok('PUT 405s', (await call(rsvp, { method: 'PUT' })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
