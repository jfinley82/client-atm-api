process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
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

const MEMBER = 'member@example.com'
const STRANGER = 'nobody@example.invalid'

// THE HARM, counted directly. A 429 is how the refusal is reported; the row and
// the email are what the limit exists to prevent. Asserting the status alone
// would pass a handler that minted a token and sent mail before saying no.
let tokenRows: { user_id: string }[] = []
let sent: { to: string }[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(b === null ? 'null' : JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.resend.com')) {
    sent.push({ to: String(body?.to || '') })
    return json({ id: 'msg-stub' })
  }
  if (url.includes('/rest/v1/users')) {
    const m = /email=eq\.([^&]+)/.exec(url)
    const email = m ? m[1] : ''
    // Exactly one member exists. Everything else is a stranger.
    if (email === MEMBER) {
      return json({ id: 'u-1', name: 'A Member', has_paid: true, status: 'active', membership_tier: 'full', role: 'user' })
    }
    return json(null)
  }
  if (url.includes('/rest/v1/magic_link_tokens')) {
    if (method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body
      tokenRows.push({ user_id: row.user_id })
      return json(row)
    }
    return json([])
  }
  return json([])
}) as typeof fetch

function call(handler: Handler, opts: { ip?: string; email?: string; method?: string } = {}) {
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
    url: '/api/auth/send-magic-link',
    headers: { 'x-forwarded-for': opts.ip || '198.51.100.4' },
    body: { email: opts.email ?? MEMBER },
    query: {},
  }
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: resBody }))
}

function reset() {
  _clearRateLimitForTests()
  tokenRows = []
  sent = []
}

;(async () => {
  const { default: sendMagicLink } = await import('../api/auth/send-magic-link')

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n-- THE CONSTRAINT: the limiter must not become a membership oracle --')
  {
    // The endpoint answers ok:true for an unknown email on purpose. If the
    // limit ran AFTER the membership lookup it would only ever fire for real
    // members, and "which addresses get 429'd" would answer the question the
    // silent-ok response exists to refuse. So the two are driven through the
    // identical sequence and compared to EACH OTHER, request by request.
    reset()
    const memberRun: { status: number; body: string }[] = []
    for (let i = 0; i < 5; i++) {
      const r = await call(sendMagicLink, { ip: '203.0.113.1', email: MEMBER })
      memberRun.push({ status: r.status, body: JSON.stringify(r.body) })
    }

    reset()
    const strangerRun: { status: number; body: string }[] = []
    for (let i = 0; i < 5; i++) {
      const r = await call(sendMagicLink, { ip: '203.0.113.1', email: STRANGER })
      strangerRun.push({ status: r.status, body: JSON.stringify(r.body) })
    }

    eq('a member and a stranger are indistinguishable, request for request', memberRun, strangerRun)

    // And specifically: the stranger's per-email budget was CONSUMED. If it
    // were not, an attacker could tell members from strangers by which
    // addresses can be hammered forever.
    ok(
      'the 4th request is refused for BOTH — the stranger burns budget too',
      memberRun[3].status === 429 && strangerRun[3].status === 429,
      JSON.stringify({ member: memberRun.map((r) => r.status), stranger: strangerRun.map((r) => r.status) })
    )
  }

  console.log('\n-- and the limit is reached before the lookup, structurally --')
  {
    // Belt and braces on the ordering: a refused request must not have queried
    // users at all. Asserted through the send/row counters, which is the only
    // observable the handler leaves behind.
    reset()
    for (let i = 0; i < 3; i++) await call(sendMagicLink, { ip: '203.0.113.2', email: MEMBER })
    const rowsBefore = tokenRows.length
    const sentBefore = sent.length

    const refused = await call(sendMagicLink, { ip: '203.0.113.2', email: MEMBER })
    eq('the 4th is 429', refused.status, 429)
    eq('  no magic_link_tokens row was written', tokenRows.length, rowsBefore)
    eq('  and no email was sent', sent.length, sentBefore)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n-- per EMAIL: 3 per 15 minutes --')
  {
    reset()
    const statuses: number[] = []
    // Different IP each time, so ONLY the per-email limit can bite. Without
    // this the per-IP budget of 10 would mask it entirely.
    for (let i = 0; i < 4; i++) {
      const r = await call(sendMagicLink, { ip: `198.51.100.${i}`, email: MEMBER })
      statuses.push(r.status)
    }
    eq('three succeed, the fourth is refused', statuses, [200, 200, 200, 429])
    eq('exactly three tokens were minted', tokenRows.length, 3)
    eq('and exactly three emails sent', sent.length, 3)

    // A different address is unaffected — the bucket is per email, not global.
    const other = await call(sendMagicLink, { ip: '198.51.100.9', email: 'someone.else@example.com' })
    eq('a different inbox is unaffected', other.status, 200)
  }

  console.log('\n-- and casing cannot mint a fresh bucket --')
  {
    // The key uses the normalised address. Keyed on raw input, ' Jane@X.com '
    // and 'jane@x.com' would be different buckets and the per-email limit would
    // be defeated by a shift key.
    reset()
    for (const variant of [MEMBER, MEMBER.toUpperCase(), `  ${MEMBER}  `]) {
      await call(sendMagicLink, { ip: '198.51.100.50', email: variant })
    }
    const fourth = await call(sendMagicLink, { ip: '198.51.100.51', email: ` ${MEMBER.toUpperCase()} ` })
    eq('a re-cased, re-padded address shares the same bucket', fourth.status, 429)
    eq('and only three emails went out across all four spellings', sent.length, 3)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n-- per IP: 10 per 60s, independent of the email dimension --')
  {
    reset()
    // A fresh address every request, so the per-email limit never fires and
    // only the per-IP budget can refuse.
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const r = await call(sendMagicLink, { ip: '203.0.113.77', email: `person${i}@example.com` })
      statuses.push(r.status)
    }
    eq('the first ten are accepted', statuses.slice(0, 10).every((s) => s === 200), true)
    eq('the eleventh is refused', statuses[10], 429)

    const otherIp = await call(sendMagicLink, { ip: '203.0.113.78', email: 'fresh@example.com' })
    eq('a different IP is unaffected', otherIp.status, 200)
  }

  console.log('\n-- both dimensions bind: either one refusing refuses --')
  {
    // Exhaust the EMAIL budget while the IP budget is untouched.
    reset()
    for (let i = 0; i < 3; i++) await call(sendMagicLink, { ip: `192.0.2.${i}`, email: MEMBER })
    const emailBound = await call(sendMagicLink, { ip: '192.0.2.200', email: MEMBER })
    eq('a fresh IP cannot spend an exhausted email budget', emailBound.status, 429)

    // Exhaust the IP budget while that address's email budget is untouched.
    reset()
    for (let i = 0; i < 10; i++) await call(sendMagicLink, { ip: '192.0.2.50', email: `x${i}@example.com` })
    const ipBound = await call(sendMagicLink, { ip: '192.0.2.50', email: 'never-seen@example.com' })
    eq('a fresh address cannot spend an exhausted IP budget', ipBound.status, 429)
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n-- the budgets, compared against their siblings rather than to literals --')
  {
    const { readFileSync } = await import('fs')
    const shapes = (src: string) =>
      [...src.matchAll(/rateLimit\(`([a-z_]+):\$\{[^}]+\}`,\s*(\d+),\s*([0-9_ *]+)\)/g)].map((m) => ({
        key: m[1],
        limit: Number(m[2]),
        // eslint-disable-next-line no-eval
        windowMs: Function(`return ${m[3].replace(/_/g, '')}`)() as number,
      }))

    const magic = shapes(readFileSync('api/auth/send-magic-link.ts', 'utf8'))
    const funnel = shapes(readFileSync('api/funnel/lead.ts', 'utf8'))[0]
    const save = shapes(readFileSync('api/leads/save.ts', 'utf8'))[0]

    const perIp = magic.find((s) => s.key === 'magic_link')
    const perEmail = magic.find((s) => s.key === 'magic_link_email')
    ok('both dimensions are present in the source', !!perIp && !!perEmail, JSON.stringify(magic))

    // Compared to each other, so tuning one public writer and forgetting the
    // rest fails here rather than leaving three answers to the same question.
    eq('per-IP limit matches funnel/lead', perIp?.limit, funnel.limit)
    eq('per-IP window matches funnel/lead', perIp?.windowMs, funnel.windowMs)
    eq('per-IP limit matches leads/save', perIp?.limit, save.limit)
    eq('per-IP window matches leads/save', perIp?.windowMs, save.windowMs)

    // The per-email budget is deliberately NOT the same shape, so it is pinned
    // by value with the reasoning attached: 3 per fifteen minutes. A per-minute
    // window at the same count would still allow 180 emails an hour into one
    // inbox.
    eq('per-email allows three', perEmail?.limit, 3)
    eq('per-email window is fifteen minutes', perEmail?.windowMs, 15 * 60_000)
    ok(
      'and it is a much longer window than the per-IP one, not a copy of it',
      (perEmail?.windowMs ?? 0) >= 15 * (perIp?.windowMs ?? Infinity),
      'the per-email window collapsed to the per-IP one'
    )
  }

  console.log('\n-- ordering, asserted on the source: the limit precedes the lookup --')
  {
    const { readFileSync } = await import('fs')
    const src = readFileSync('api/auth/send-magic-link.ts', 'utf8')
    const limitAt = src.indexOf('rateLimit(')
    const lookupAt = src.indexOf(".from('users')")
    ok('rateLimit appears before the users lookup', limitAt >= 0 && lookupAt > limitAt, `limit@${limitAt} lookup@${lookupAt}`)

    // The guard comment that explains WHY has to survive too — the next person
    // to tidy this file needs to know that moving the limit down re-creates
    // the oracle.
    ok('and the oracle hazard is written down', /membership oracle/i.test(src))

    // The property that made this endpoint safe in the first place is still
    // asserted here, so a change to the limit cannot quietly take it with it.
    ok('the lookup-only guarantee is still declared', /do not create new users/i.test(src))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
