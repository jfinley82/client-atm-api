// A BROKEN CALENDAR CONNECTION IS WRITTEN DOWN, ONCE, AND CLEARED BY BOTH
// THINGS THAT FIX IT.
//
// The half that silently rots is CLEARING. A flag that sets correctly and never
// clears becomes a permanent red badge on a working calendar, and the fix for
// that is always to stop trusting the badge — so both clearing paths are driven
// here through the real functions, not through hand-built updates.
//
// The stub models two things PostgREST actually does, because the design leans
// on both and a stub that ignored them would pass a broken implementation:
//   - a PATCH applies its query-string filters, so `.is('invalid_since', null)`
//     genuinely no-ops once the column is set (that is the whole transition)
//   - an upsert MERGES: columns absent from the payload keep their old value,
//     which is why saveGoogleConnection has to name the two nulls explicitly

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.CALENDAR_TOKEN_KEY = 'stub-calendar-key'
process.env.GOOGLE_CLIENT_ID = 'stub-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'stub-client-secret'
process.env.GOOGLE_REDIRECT_URI = 'https://api.example.test/api/calendar/google/callback'

import fs from 'fs'
import path from 'path'
import { projectSelect } from './support/postgrest'
import {
  INVALID_REASONS,
  connectionState,
  isCoachFixable,
  blocksRefresh,
} from '../lib/calendarConnectionHealth'

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
  ok(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PAST = new Date(Date.now() - 3_600_000).toISOString()

type Row = Record<string, any>

// ---- the stub ---------------------------------------------------------------

let row: Row | null = null
let tokenCalls = 0
let tokenHandler: () => Response = () => new Response('{}', { status: 500 })
let writes: { body: Row; filters: string }[] = []

function applyFilters(r: Row, url: string): boolean {
  // Only the filters this code actually uses. `invalid_since=is.null` is the
  // one that matters: it is what makes the failure write a TRANSITION.
  const qs = url.split('?')[1] || ''
  for (const part of qs.split('&')) {
    const [k, v] = part.split('=')
    if (!v) continue
    if (k === 'select' || k === 'on_conflict' || k === 'order' || k === 'limit') continue
    const key = decodeURIComponent(k)
    const val = decodeURIComponent(v)
    if (val === 'is.null' && r[key] !== null && r[key] !== undefined) return false
    if (val.startsWith('eq.') && String(r[key]) !== val.slice(3)) return false
  }
  return true
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()

  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    tokenCalls++
    return tokenHandler()
  }

  if (url.includes('/rest/v1/calendar_connections')) {
    const body = init?.body ? JSON.parse(init.body) : null
    if (method === 'GET') {
      return new Response(JSON.stringify(projectSelect(url, row, 200)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'PATCH') {
      writes.push({ body, filters: url.split('?')[1] || '' })
      if (row && applyFilters(row, url)) Object.assign(row, body)
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'POST') {
      // PostgREST upsert MERGES: only the keys in the payload are written.
      writes.push({ body, filters: url.split('?')[1] || '' })
      row = row ? { ...row, ...body } : { ...body }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const googleError = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code, error_description: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const googleOk = () =>
  new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

;(async () => {
  const { encryptToken } = await import('../lib/cryptoTokens')
  const { getValidAccessToken, saveGoogleConnection } = await import('../lib/googleCalendar')

  // Every case starts from the SAME connection: a stored refresh token and an
  // expired access token, so a refresh is always attempted. Only the named
  // variable differs between fixtures.
  function seed(extra: Row = {}) {
    row = {
      user_id: USER_ID,
      provider: 'google',
      access_token: encryptToken('stale-access'),
      refresh_token: encryptToken('stored-refresh'),
      expires_at: PAST,
      calendar_id: 'primary',
      calendar_email: 'coach@example.test',
      connected_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      invalid_since: null,
      invalid_reason: null,
      ...extra,
    }
    writes = []
    tokenCalls = 0
  }

  console.log('\n-- 1. a successful refresh clears both columns, in ONE write --')
  {
    // invalid_client, NOT invalid_grant. The retry gate means a coach-fixable
    // reason never reaches the refresh at all — for those, a reconnect is the
    // only way back, which is what makes case 2 load-bearing rather than
    // belt-and-braces. Seeding invalid_grant here tests the gate, not the clear.
    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_client' })
    tokenHandler = googleOk
    const got = await getValidAccessToken(USER_ID)

    ok('a token comes back', got?.access_token === 'fresh-access', JSON.stringify(got))
    // ONE WRITE, NOT TWO. A second write to clear would leave a window where a
    // concurrent read reports a working connection as broken.
    eq('exactly one write', writes.length, 1)
    const w = writes[0]?.body || {}
    ok('and it carries the new access token', typeof w.access_token === 'string' && w.access_token !== '', JSON.stringify(w))
    eq('…and invalid_since null in the same object', w.invalid_since, null)
    eq('…and invalid_reason null in the same object', w.invalid_reason, null)
    eq('the row ends up healthy', [row?.invalid_since, row?.invalid_reason], [null, null])

    // AND THE INTERACTION, pinned rather than left implicit: a refresh cannot
    // clear a coach-fixable reason, because the gate stops it before the call.
    // If someone removes the gate, this flips green and case 2 stops being the
    // only thing standing between a reconnected coach and a permanent badge.
    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_grant' })
    tokenHandler = googleOk
    await getValidAccessToken(USER_ID)
    eq('but a refresh cannot clear invalid_grant', row?.invalid_reason, 'invalid_grant')
  }

  console.log('\n-- 2. reconnecting clears them, through the real upsert --')
  {
    // Driven through saveGoogleConnection, not a hand-built update, because the
    // defect this guards is specific to the upsert: PostgREST merges, so columns
    // omitted from the payload SURVIVE. A coach who reconnects would otherwise
    // keep invalid_since forever and their only remedy is the one they just did.
    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_grant' })
    await saveGoogleConnection(USER_ID, { access_token: 'a', refresh_token: 'r', expires_in: 3600 } as any, 'coach@example.test')
    eq('the reconnected row is healthy', [row?.invalid_since, row?.invalid_reason], [null, null])
    const upsert = writes.find((w) => 'connected_at' in (w.body || {}))
    ok('and the upsert NAMED both columns', upsert !== undefined && 'invalid_since' in upsert.body && 'invalid_reason' in upsert.body, JSON.stringify(upsert?.body))
  }

  console.log('\n-- 3. a transient failure records nothing --')
  {
    // TWO FIXTURES, ONE VARIABLE. Same row, same clock, same stored tokens —
    // only the failure kind differs. If both were invalid_grant this assertion
    // would be decorative and green would mean nothing.
    seed()
    tokenHandler = () => googleError(400, 'invalid_grant')
    await getValidAccessToken(USER_ID)
    const afterTerminal = row?.invalid_reason
    eq('evidence about the grant IS recorded', afterTerminal, 'invalid_grant')

    seed()
    tokenHandler = () => googleError(503, 'unavailable')
    await getValidAccessToken(USER_ID)
    eq('a 503 records nothing', [row?.invalid_since, row?.invalid_reason], [null, null])

    seed()
    tokenHandler = () => {
      throw new Error('ECONNRESET')
    }
    await getValidAccessToken(USER_ID)
    eq('a transport failure records nothing', [row?.invalid_since, row?.invalid_reason], [null, null])

    seed()
    tokenHandler = () => googleError(400, 'invalid_request')
    await getValidAccessToken(USER_ID)
    eq('an unrecognised code records nothing', [row?.invalid_since, row?.invalid_reason], [null, null])
  }

  console.log('\n-- 4. invalid_since survives the second and third failure --')
  {
    seed()
    tokenHandler = () => googleError(400, 'invalid_client')
    await getValidAccessToken(USER_ID)
    const first = row?.invalid_since
    ok('the first failure stamps it', typeof first === 'string', String(first))

    // invalid_client keeps retrying (see below), so a second and third failure
    // genuinely reach the write path — which is what makes this test able to
    // catch a re-stamp at all.
    await new Promise((r) => setTimeout(r, 5))
    await getValidAccessToken(USER_ID)
    await new Promise((r) => setTimeout(r, 5))
    await getValidAccessToken(USER_ID)

    eq('and three failures leave ONE timestamp', row?.invalid_since, first)
    // The transition is enforced by the query, not by a read-then-write race.
    const marks = writes.filter((w) => w.body && 'invalid_since' in w.body && w.body.invalid_since !== null)
    ok('every marking write is conditional on it being null', marks.length > 0 && marks.every((w) => w.filters.includes('invalid_since=is.null')), marks.map((m) => m.filters).join(' | '))
    // updated_at tracks successful token work: `updated_at > connected_at` is the
    // only evidence a refresh has ever succeeded. A failure must not forge it.
    ok('and no failure bumped updated_at', marks.every((w) => !('updated_at' in w.body)), JSON.stringify(marks.map((m) => m.body)))
  }

  console.log('\n-- 5. a terminal reason stops the outbound call --')
  {
    // ASSERT THE CALL COUNT, NOT THE STATE. The point is that a coach reloading
    // settings does not drive a loop against Google's token endpoint.
    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_grant' })
    tokenHandler = googleOk
    const got = await getValidAccessToken(USER_ID)
    eq('invalid_grant makes no token call', tokenCalls, 0)
    eq('and yields no token', got, null)

    // THE CONTRAST, differing only in the reason. invalid_client is ours to fix
    // with a deploy, which touches no row — so if it blocked, the connection
    // would stay broken after we fixed it with nothing left to notice. Retrying
    // is how it heals.
    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_client' })
    tokenHandler = googleOk
    const healed = await getValidAccessToken(USER_ID)
    eq('invalid_client DOES retry', tokenCalls, 1)
    ok('and a success heals it', healed?.access_token === 'fresh-access', JSON.stringify(healed))
    eq('clearing both columns', [row?.invalid_since, row?.invalid_reason], [null, null])
  }

  console.log('\n-- 6. four states, and `connected` unchanged for existing callers --')
  {
    eq('no row', connectionState(null), 'not_connected')
    eq('healthy row', connectionState({ invalid_reason: null }), 'connected')
    eq('invalid_grant', connectionState({ invalid_reason: 'invalid_grant' }), 'needs_reconnect')
    eq('decrypt_failed', connectionState({ invalid_reason: 'decrypt_failed' }), 'needs_reconnect')
    eq('invalid_client', connectionState({ invalid_reason: 'invalid_client' }), 'app_misconfigured')
    // A value the CHECK forbids must not silently read as broken.
    eq('an unknown reason reads as connected', connectionState({ invalid_reason: 'nonsense' }), 'connected')

    const { default: status } = await import('../api/calendar/google/status')
    const { createSessionToken } = await import('../lib/auth')
    const token = await createSessionToken(USER_ID)

    const call = async () => {
      let code = 0
      let body: any = null
      const res: any = {
        setHeader() {},
        status(c: number) {
          code = c
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
      await status(
        { method: 'GET', url: '/api/calendar/google/status', headers: { authorization: `Bearer ${token}` }, query: {} } as any,
        res
      )
      return { code, body }
    }

    seed({ invalid_since: '2026-08-02T00:00:00.000Z', invalid_reason: 'invalid_grant' })
    tokenHandler = googleOk
    const broken = await call()
    eq('a broken connection still reports connected:true', broken.body?.connected, true)
    eq('…and state needs_reconnect', broken.body?.state, 'needs_reconnect')
    ok('…and says since when', typeof broken.body?.invalid_since === 'string', JSON.stringify(broken.body))

    seed()
    tokenHandler = googleOk
    const healthy = await call()
    eq('a healthy connection', [healthy.body?.connected, healthy.body?.state], [true, 'connected'])
    // THE DISCOVERER. The endpoint's own probe is what refreshed the expired
    // token — proof it is not just reading the row.
    eq('and status probed Google itself', tokenCalls, 1)

    row = null
    const none = await call()
    eq('no connection at all', [none.body?.connected, none.body?.state], [false, 'not_connected'])
  }

  console.log('\n-- the constant and the CHECK constraint agree --')
  {
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/097_calendar_connection_health.sql'), 'utf8')
    const m = /invalid_reason in \(([^)]*)\)/.exec(sql)
    const inSql = (m?.[1] || '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    eq('same values, same order', inSql, [...INVALID_REASONS])
    ok('the pair constraint exists', /invalid_since is null\) = \(invalid_reason is null/.test(sql), 'a half-set row would be accepted')
    ok('and `unavailable` is not one of them', !inSql.includes('unavailable'), 'a Google outage would mark a healthy coach broken')
  }

  console.log('\n-- the retry gate is exactly the coach-fixable set --')
  {
    for (const r of INVALID_REASONS) {
      eq(`${r}: blocksRefresh === isCoachFixable`, blocksRefresh(r), isCoachFixable(r))
    }
    // Stated separately so the intent survives a refactor that makes the two
    // functions one: every blocked connection must have a way out, and the way
    // out is a reconnect, which only helps for the coach-fixable reasons.
    eq('invalid_client is not blocked', blocksRefresh('invalid_client'), false)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
