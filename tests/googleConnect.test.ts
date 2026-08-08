// The Google connect handshake, in both modes.
//
// The outbound leg was unreachable from the frontend and the comment in
// connect.ts said otherwise: it claimed a Bearer-only caller could fetch the
// endpoint and read the redirect Location. A cross-origin 302 is an
// opaqueredirect — Location is not readable, by design — so the pattern had
// never been run by anybody. ?mode=url replaces it.
//
// THE GUARD MOST LIKELY TO BE BROKEN BY THAT CHANGE is the nonce cookie: the
// JSON path returns a body instead of a redirect, and dropping the Set-Cookie on
// the way past would leave every callback failing with a nonce mismatch and
// nothing on the connect side looking wrong. It is driven here in BOTH
// directions — matching and mismatching — through the JSON path specifically.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.APP_URL = 'https://app.microtrainingmethod.com'
process.env.GOOGLE_CLIENT_ID = 'stub-client-id.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'stub-client-secret'
process.env.GOOGLE_REDIRECT_URI = 'https://api.microtrainingmethod.com/api/calendar/google/callback'
process.env.CALENDAR_TOKEN_KEY = 'stub-token-key'

import { projectSelect } from './support/postgrest'
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

const COACH = '5c8ba4ad-0c04-4816-9fcf-b0b988a74ae6'
const NONCE_COOKIE = 'catm_gcal_nonce'

let tables: Record<string, any[]> = {}
let googleCalls: string[] = []

function reset() {
  googleCalls = []
  tables = {
    users: [{ id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {}, email: 'coach@example.invalid', name: 'Jamaul Finley' }],
    calendar_connections: [],
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  // Google's token endpoint and calendar API, stubbed so the callback can
  // complete without leaving the process.
  if (url.includes('oauth2.googleapis.com/token')) {
    googleCalls.push('token')
    return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events' })
  }
  if (url.includes('googleapis.com/calendar/v3/calendars/primary')) {
    googleCalls.push('primary')
    return json({ id: 'coach@example.invalid' })
  }

  const table = /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
  if (!table) return json([])
  tables[table] = tables[table] || []
  const method = (init?.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const rows = Array.isArray(body) ? body : [body]
    tables[table].push(...rows)
    return json(rows)
  }
  const eqs = [...url.matchAll(/[?&]([a-z_]+)=eq\.([^&]+)/g)]
  const rows = tables[table].filter((r) => eqs.every(([, k, v]) => k === 'select' || String(r[k]) === v))
  const h = init?.headers
  const accept = h && typeof h.get === 'function' ? h.get('Accept') : h?.Accept ?? h?.accept
  return json(/vnd\.pgrst\.object/.test(String(accept || '')) ? rows[0] ?? null : rows)
}) as typeof fetch

/** Captures status, body, Location and Set-Cookie — the redirect and the cookie
 *  are the two things under test and neither is in the JSON body. */
async function call(handler: Handler, opts: { query?: Record<string, string>; cookie?: string; authed?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (opts.authed !== false) headers.authorization = `Bearer ${await createSessionToken(COACH)}`
  if (opts.cookie) headers.cookie = opts.cookie

  let status = 0
  let body: any = null
  let location: string | null = null
  const outHeaders: Record<string, string> = {}
  const res: any = {
    setHeader(k: string, v: string) { outHeaders[k.toLowerCase()] = v },
    getHeader(k: string) { return outHeaders[k.toLowerCase()] },
    status(c: number) { status = c; return res },
    json(v: unknown) { body = v; return res },
    end() { return res },
    redirect(code: number, to: string) { status = code; location = to; return res },
  }
  await handler({ method: 'GET', headers, query: opts.query || {}, body: null } as any, res)
  return { status, body, location, setCookie: outHeaders['set-cookie'] ?? null }
}

const nonceFrom = (setCookie: string | null) =>
  setCookie ? /catm_gcal_nonce=([^;]*)/.exec(setCookie)?.[1] ?? null : null

;(async () => {
  const { default: connect } = await import('../api/calendar/google/connect')
  const { default: callback } = await import('../api/calendar/google/callback')

  console.log('\n-- ?mode=url: 200 { url }, AND the cookie on the same response --')
  {
    reset()
    const res = await call(connect, { query: { mode: 'url' } })

    eq('200', res.status, 200)
    ok('a consent URL is returned', typeof res.body?.url === 'string' && res.body.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'), JSON.stringify(res.body))
    ok('it is NOT a redirect', res.location === null)

    // THE PART MOST LIKELY TO BE DROPPED. Asserted on the response, not inferred
    // from the flow working — a missing cookie here fails the callback later,
    // where it reads as a state problem rather than a connect one.
    ok('the nonce cookie is set on the JSON response', !!res.setCookie, 'no Set-Cookie — every callback would fail nonce matching')
    const cookie = String(res.setCookie || '')
    ok('HttpOnly', /HttpOnly/i.test(cookie))
    ok('Secure', /Secure/i.test(cookie))
    // SameSite=Lax is load-bearing: Google returns the browser to the API origin
    // as a top-level GET, and Strict would withhold the cookie on that navigation.
    ok('SameSite=Lax', /SameSite=Lax/i.test(cookie))
    ok('and the nonce is non-trivial', (nonceFrom(res.setCookie) || '').length >= 32)

    const url = new URL(res.body.url)
    eq('offline access, so a refresh token is issued', url.searchParams.get('access_type'), 'offline')
    eq('and forced consent, so one is issued even on re-consent', url.searchParams.get('prompt'), 'consent')
    ok('carries a signed state', (url.searchParams.get('state') || '').split('.').length === 3)
    eq('and the redirect_uri is the configured one', url.searchParams.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI)
  }

  console.log('\n-- the 302 path is unchanged for a cookie-session caller --')
  {
    reset()
    const res = await call(connect, {})
    eq('302', res.status, 302)
    ok('to Google', String(res.location).startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))
    ok('no JSON body', res.body === null)
    // Both modes set it. If only one did, the other's flow would die at the
    // callback with a message about state rather than about cookies.
    ok('and it sets the nonce cookie too', !!res.setCookie)
  }

  console.log('\n-- the two modes differ ONLY in how the URL is delivered --')
  {
    reset()
    const asJson = await call(connect, { query: { mode: 'url' } })
    const asRedirect = await call(connect, {})
    const a = new URL(asJson.body.url)
    const b = new URL(String(asRedirect.location))
    // Every parameter but `state` must match — state carries a fresh nonce hash
    // and a jti per flow, so it is expected to differ.
    const strip = (u: URL) => {
      const p = new URLSearchParams(u.searchParams)
      p.delete('state')
      return `${u.origin}${u.pathname}?${p.toString()}`
    }
    eq('same consent URL apart from the per-flow state', strip(a), strip(b))
    ok('and the states DO differ, because each flow has its own nonce', a.searchParams.get('state') !== b.searchParams.get('state'))
  }

  console.log('\n-- an unauthenticated caller is refused identically in both modes --')
  {
    reset()
    const json = await call(connect, { query: { mode: 'url' }, authed: false })
    const redirect = await call(connect, { authed: false })
    eq('JSON path refuses', json.status, 401)
    eq('302 path refuses the same way', redirect.status, 401)
    eq('byte-identical bodies', JSON.stringify(json.body), JSON.stringify(redirect.body))
    ok('and neither leaks a consent URL', !json.body?.url && redirect.location === null)
    ok('nor sets a nonce cookie', !json.setCookie && !redirect.setCookie)
  }

  console.log('\n-- the callback still enforces the nonce, reached through the JSON path --')
  {
    // THE FULL CHAIN, both directions. The connect response is the only source
    // of both the state and the cookie, so this is the real handshake rather
    // than a hand-built state.
    reset()
    const started = await call(connect, { query: { mode: 'url' } })
    const state = new URL(started.body.url).searchParams.get('state') as string
    const nonce = nonceFrom(started.setCookie) as string

    // PASSING DIRECTION.
    const good = await call(callback, { query: { code: 'auth-code', state }, cookie: `${NONCE_COOKIE}=${nonce}` })
    eq('the matching cookie completes the flow', good.status, 302)
    ok('and lands on the connected page', String(good.location).includes('gcal=connected'), String(good.location))
    eq('the token exchange happened', googleCalls.includes('token'), true)
    eq('and a connection row was written', tables.calendar_connections.length, 1)

    // FAILING DIRECTION — a wrong nonce.
    reset()
    const started2 = await call(connect, { query: { mode: 'url' } })
    const state2 = new URL(started2.body.url).searchParams.get('state') as string
    const wrong = await call(callback, { query: { code: 'auth-code', state: state2 }, cookie: `${NONCE_COOKIE}=${'0'.repeat(64)}` })
    ok('a mismatched nonce is refused', String(wrong.location).includes('gcal=error&reason=bad_state'), String(wrong.location))
    eq('nothing was exchanged', googleCalls.length, 0)
    eq('and nothing was written', tables.calendar_connections.length, 0)

    // FAILING DIRECTION — no cookie at all, which is what a dropped Set-Cookie
    // on the JSON path would produce.
    reset()
    const started3 = await call(connect, { query: { mode: 'url' } })
    const state3 = new URL(started3.body.url).searchParams.get('state') as string
    const missing = await call(callback, { query: { code: 'auth-code', state: state3 } })
    ok('a missing cookie is refused', String(missing.location).includes('gcal=error&reason=bad_state'), String(missing.location))
    eq('still nothing exchanged', googleCalls.length, 0)

    // And a state that was never signed by us.
    reset()
    const forged = await call(callback, { query: { code: 'auth-code', state: 'not.a.jwt' }, cookie: `${NONCE_COOKIE}=whatever` })
    ok('an unsigned state is refused', String(forged.location).includes('gcal=error&reason=bad_state'))
  }

  console.log('\n-- misconfiguration answers in the caller\'s own language --')
  {
    reset()
    const saved = process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_ID

    const json = await call(connect, { query: { mode: 'url' } })
    // NOT a redirect. An opaque redirect is exactly as unreadable for an error
    // as it is for the consent URL, so the JSON caller would learn nothing.
    eq('the JSON caller gets a status it can read', json.status, 503)
    eq('and a named reason', json.body?.error, 'not_configured')
    ok('with no cookie, since no flow started', !json.setCookie)

    const redirect = await call(connect, {})
    eq('the navigation caller still gets a redirect', redirect.status, 302)
    ok('to the settings page with a reason', String(redirect.location).includes('gcal=error&reason=not_configured'))

    process.env.GOOGLE_CLIENT_ID = saved
  }

  console.log('\n-- the comment no longer describes a pattern nobody ran --')
  {
    const { readFileSync } = await import('fs')
    const src = readFileSync('api/calendar/google/connect.ts', 'utf8')
    // AIMED AT THE ADVICE, NOT THE WORDS. The file still quotes the old text —
    // deliberately, so the next reader knows what was wrong — so a guard on the
    // phrase itself flags the retraction as if it were the defect. What must not
    // return is the IMPERATIVE that made it advice.
    ok(
      'the file no longer INSTRUCTS a Bearer frontend to read a redirect',
      !/should instead fetch this endpoint/.test(src),
      'the comment tells a Bearer frontend to do something it cannot do'
    )
    // And the retraction is present, so "no advice" cannot be satisfied by
    // deleting the whole explanation and leaving the next person to rediscover it.
    ok('the reason it cannot work is written down', /opaqueredirect/.test(src))
    ok('both fetch modes are named as failing', /redirect: 'manual'/.test(src) && /redirect: 'follow'/.test(src))
    ok('along with why a query parameter beat Accept negotiation', /Accept: application\/json/.test(src))
    ok('and the working replacement is named', /\?mode=url/.test(src))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
