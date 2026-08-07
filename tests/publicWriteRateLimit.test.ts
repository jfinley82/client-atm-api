process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

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

// Counts writes that actually reached the database. The point of a throttle on
// a public write endpoint is that the table stops growing, so "the 11th request
// got a 429" is only half the assertion — the other half is that it wrote
// nothing on the way to saying so.
let writes: { method: string; table: string }[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
  if (url.includes('/rest/v1/')) {
    const table = (/\/rest\/v1\/([a-z_]+)/.exec(url) || [, '?'])[1] as string
    if (method !== 'GET' && method !== 'HEAD') writes.push({ method, table })
    return json(null)
  }
  return json([])
}) as typeof fetch

function call(handler: Handler, opts: { ip?: string; method?: string; body?: unknown } = {}) {
  let status = 0
  let resBody: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { resBody = v; return res },
    end() { return res },
  }
  const req: any = {
    method: opts.method || 'POST',
    url: '/api/leads/save',
    headers: { 'x-forwarded-for': opts.ip || '198.51.100.4' },
    body: opts.body ?? { email: 'a@example.com', first_name: 'A' },
    query: {},
  }
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: resBody }))
}

;(async () => {
  const { default: leadsSave } = await import('../api/leads/save')

  console.log('\n-- /api/leads/save throttles, and the throttled request writes nothing --')
  {
    _clearRateLimitForTests()
    writes = []

    // The budget copied from api/funnel/lead.ts: 10 per IP per minute.
    const results: number[] = []
    for (let i = 0; i < 10; i++) {
      const r = await call(leadsSave, { ip: '203.0.113.10', body: { email: `person${i}@example.com` } })
      results.push(r.status)
    }
    ok('the first 10 are accepted', results.every((s) => s === 200), JSON.stringify(results))
    eq('and all 10 reached the table', writes.length, 10)

    const before = writes.length
    const eleventh = await call(leadsSave, { ip: '203.0.113.10', body: { email: 'flood@example.com' } })
    eq('the 11th is refused', eleventh.status, 429)
    eq('with the same error shape the other public writers use', eleventh.body?.error, 'rate_limited')
    eq('AND it wrote nothing — the table stopped growing', writes.length, before)
  }

  console.log('\n-- the budget is per IP, not global --')
  {
    // Without this, a limiter keyed on a constant would pass every assertion
    // above while taking the whole endpoint down for everyone after ten
    // requests from anybody.
    _clearRateLimitForTests()
    for (let i = 0; i < 11; i++) await call(leadsSave, { ip: '203.0.113.20', body: { email: `a${i}@example.com` } })

    writes = []
    const other = await call(leadsSave, { ip: '203.0.113.99', body: { email: 'unrelated@example.com' } })
    eq('a different IP is unaffected', other.status, 200)
    eq('and its write went through', writes.length, 1)
  }

  console.log('\n-- the key is the client IP, not the whole proxy chain --')
  {
    _clearRateLimitForTests()
    // clientIp() takes the first hop. If it took the raw header instead, an
    // attacker prepending a random value would mint a fresh bucket per request
    // and the limit would never bind.
    for (let i = 0; i < 10; i++) {
      await call(leadsSave, { ip: '203.0.113.30, 70.41.3.18', body: { email: `b${i}@example.com` } })
    }
    const spoofed = await call(leadsSave, { ip: '203.0.113.30, 10.0.0.9', body: { email: 'c@example.com' } })
    eq('a changed downstream hop does not buy a new budget', spoofed.status, 429)
  }

  console.log('\n-- one budget, not two: leads/save matches funnel/lead by value --')
  {
    const { readFileSync } = await import('fs')
    const shape = (src: string) => {
      const m = /rateLimit\(`([a-z_]+):\$\{[^}]+\}`,\s*(\d+),\s*([0-9_]+)\)/.exec(src)
      return m ? { limit: Number(m[2]), windowMs: Number(m[3].replace(/_/g, '')) } : null
    }
    const save = shape(readFileSync('api/leads/save.ts', 'utf8'))
    const funnel = shape(readFileSync('api/funnel/lead.ts', 'utf8'))

    ok('both call sites parse', !!save && !!funnel, JSON.stringify({ save, funnel }))
    // Compared against EACH OTHER rather than against a literal, so tuning one
    // and forgetting the other fails here instead of leaving two answers to
    // "how fast may a stranger write to us".
    eq('same limit', save?.limit, funnel?.limit)
    eq('same window', save?.windowMs, funnel?.windowMs)
    ok('and leads/save keys on the client IP like its sibling', readFileSync('api/leads/save.ts', 'utf8').includes('clientIp(req)'))
  }

  console.log('\n-- THE PROPERTY: every unauthenticated write endpoint is throttled --')
  {
    const { readFileSync, readdirSync, statSync } = await import('fs')
    const { join } = await import('path')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    // Session gates, including requireFunnelBuilder — an earlier version of this
    // sweep omitted it and reported a dozen authenticated coach endpoints as
    // public, which is the shape of predicate error that makes a sweep worse
    // than no sweep.
    const AUTH = ['requireActiveUser', 'requireAdmin', 'requireActiveSession', 'requireCapability', 'requireFunnelBuilder']
    // Caller-authenticated webhooks and retired routes carry their own gates.
    const WEBHOOK = ['respondGone', 'constructEvent', 'svix', 'timingSafeEqual', 'requireWebhookSecret']

    const publicWriters = walk('api').filter((f) => {
      const src = stripComments(readFileSync(f, 'utf8'))
      const writes = /\.from\(['"][a-z_]+['"]\)[\s\S]{0,80}?\.(insert|upsert|update|delete)\(/.test(src)
      if (!writes) return false
      if (AUTH.some((a) => src.includes(a))) return false
      if (WEBHOOK.some((w) => src.includes(w))) return false
      // A signed token IS a credential: those endpoints cannot be driven without
      // one, so they are a different risk profile from an open form post.
      if (/verify[A-Z][A-Za-z]*Token/.test(src)) return false
      return true
    })

    // By value. The set is small enough to name, and naming it is the point —
    // a sixth file appearing here is a decision someone has to make rather than
    // a default they inherit.
    const EXPECTED = [
      'api/ai-coach/chat.ts',
      'api/auth/callback.ts',
      'api/auth/send-magic-link.ts',
      'api/funnel/lead.ts',
      'api/leads/save.ts',
    ]
    for (const f of EXPECTED) ok(`the sweep sees ${f}`, publicWriters.includes(f), `swept: ${publicWriters.join(', ')}`)
    const surprises = publicWriters.filter((f) => !EXPECTED.includes(f))
    ok('and finds no unaccounted-for public writer', surprises.length === 0, `NEW: ${surprises.join(', ')}`)

    // Deliberate exception, with its reason, so it is a decision and not an
    // oversight: the magic-link token IS the credential. It is 32 random bytes,
    // so brute force is not a threat a per-minute counter addresses, and
    // throttling redemption would penalise a member clicking their own link
    // twice more than it would inconvenience anybody else.
    const EXEMPT = ['api/auth/callback.ts']

    // KNOWN GAP, recorded rather than silently tolerated. send-magic-link is
    // public, mints a magic_link_tokens row and SENDS AN EMAIL per request for
    // any address that is a member — so it is both unbounded row growth and a
    // way to bomb a specific person's inbox. It is not fixed here because it is
    // a live login path and a badly chosen limit locks members out; that is a
    // decision to make deliberately, not a line to slip into an adjacent
    // change. Its own docstring cites it as the precedent OTHER endpoints
    // should follow, which is how it went unnoticed.
    const KNOWN_GAPS = ['api/auth/send-magic-link.ts']

    for (const f of publicWriters) {
      const src = stripComments(readFileSync(f, 'utf8'))
      const limited = src.includes('rateLimit(')
      if (EXEMPT.includes(f)) {
        // Anchored to WHY it is exempt rather than to the fact that it is:
        // `!limited || true` is always true and would have asserted nothing.
        // The exemption rests on the token being the credential, so that is
        // what gets checked — if this file ever stops redeeming a signed token,
        // the reason evaporates and the exemption has to be re-argued.
        ok(`${f} is exempt because the token IS the credential`, src.includes('magic_link_tokens') && src.includes('used_at'), 'the exemption no longer holds')
        continue
      }
      if (KNOWN_GAPS.includes(f)) {
        // Asserted in the direction that matters: if somebody fixes it, this
        // fails and the gap comes off the list. A test that just skipped it
        // would let the list rot into permanent.
        ok(`${f} is still the known gap (fix it and delete this line)`, !limited, 'now throttled — remove it from KNOWN_GAPS')
        continue
      }
      ok(`${f} is rate limited`, limited, 'a public write endpoint with no throttle')
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
