process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
import { createSessionToken, verifySessionToken } from '../lib/auth'
import { MEMBERSHIP_TIERS } from '../lib/entitlements'
import { INVITE_TTL_MS, LOGIN_TTL_MS } from '../lib/tokenLifetimes'

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

const ADMIN = 'admin-1'
const NON_ADMIN = 'member-1'

type UserRow = {
  id: string
  email: string
  name: string | null
  membership_tier: string
  status: string
  role: string
  add_ons: Record<string, boolean>
  created_at: string
  profession: null
  has_paid: boolean
  quiz_completed: boolean
  quiz_score: null
  video_watched: boolean
}
type TokenRow = { id: string; user_id: string; token: string; expires_at: string; used_at: string | null; kind: string }

let users: UserRow[] = []
let tokens: TokenRow[] = []
let mailed: { to: string; link: string }[] = []
let seq = 0

// The clock every handler reads. Date.now is patched; `new Date()` with no
// args is deliberately NOT used for any expiry decision in the code under test,
// which is what makes a clock-controlled test possible at all.
const REAL_NOW = Date.now()
let fakeNow = REAL_NOW
Date.now = () => fakeNow

function mkUser(over: Partial<UserRow> & { id: string; email: string }): UserRow {
  return {
    name: null,
    membership_tier: 'full',
    status: 'active',
    role: 'user',
    add_ons: {},
    created_at: new Date(REAL_NOW).toISOString(),
    profession: null,
    has_paid: false,
    quiz_completed: false,
    quiz_score: null,
    video_watched: false,
    ...over,
  }
}

function reset() {
  users = [
    mkUser({ id: ADMIN, email: 'admin@mtm.test', name: 'Admin', role: 'admin', membership_tier: 'full' }),
    mkUser({ id: NON_ADMIN, email: 'member@mtm.test', name: 'Member', membership_tier: 'full' }),
  ]
  tokens = []
  mailed = []
  seq = 0
  fakeNow = REAL_NOW
}

function params(url: string): URLSearchParams {
  const q = url.indexOf('?')
  return new URLSearchParams(q === -1 ? '' : url.slice(q + 1))
}
function eqParam(url: string, key: string): string | null {
  const v = params(url).get(key)
  return v && v.startsWith('eq.') ? v.slice(3) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(b === null ? 'null' : JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  // Whether the caller used .single()/.maybeSingle() is decided by the FILTERS,
  // not by sniffing the Accept header: supabase-js may pass headers as a
  // Headers instance, and reading it as a plain object silently yields "array"
  // for every request — which showed up as a 403 from the admin gate rather
  // than as anything resembling a shape problem.
  // Every call site in the code under test that filters by a unique column
  // (users.id, users.email, magic_link_tokens.token, magic_link_tokens.id)
  // takes exactly one row; the only unfiltered read is the member LIST.
  const p = params(url)
  const singular = ['id', 'email', 'token'].some((k) => (p.get(k) || '').startsWith('eq.'))
  const one = (rows: unknown[]) => json(rows[0] ?? null)

  // ── Resend ────────────────────────────────────────────────────────────────
  if (url.includes('api.resend.com')) {
    const link = String(body?.template?.variables?.LOGIN_LINK || '')
    mailed.push({ to: String(body?.to || ''), link })
    return json({ id: `msg-${++seq}` })
  }

  // ── users ─────────────────────────────────────────────────────────────────
  if (url.includes('/rest/v1/users')) {
    if (method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body
      // THE REAL TABLE'S CONSTRAINTS. A mock without them passes a design the
      // database rejects — users_email_key is UNIQUE and
      // users_membership_tier_check is a CHECK, both verified in production.
      if (users.some((u) => u.email === row.email)) {
        return json({ code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"' }, 409)
      }
      if (!(MEMBERSHIP_TIERS as readonly string[]).includes(row.membership_tier)) {
        return json({ code: '23514', message: 'violates check constraint "users_membership_tier_check"' }, 400)
      }
      const created = mkUser({ id: `u-${++seq}`, email: row.email, name: row.name ?? null, membership_tier: row.membership_tier, status: row.status || 'active', add_ons: row.add_ons || {} })
      users.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const target = users.find((u) => u.id === id)
      if (target) Object.assign(target, body)
      return one(target ? [target] : [])
    }
    const id = eqParam(url, 'id')
    const email = eqParam(url, 'email')
    const tier = eqParam(url, 'membership_tier')
    const status = eqParam(url, 'status')
    let rows = users.slice()
    if (id) rows = rows.filter((u) => u.id === id)
    if (email) rows = rows.filter((u) => u.email === email)
    if (tier) rows = rows.filter((u) => u.membership_tier === tier)
    if (status) rows = rows.filter((u) => u.status === status)
    return singular ? one(rows) : json(rows)
  }

  // ── magic_link_tokens ─────────────────────────────────────────────────────
  if (url.includes('/rest/v1/magic_link_tokens')) {
    if (method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body
      const created: TokenRow = {
        id: `t-${++seq}`,
        user_id: row.user_id,
        token: row.token,
        expires_at: row.expires_at,
        used_at: null,
        kind: row.kind ?? 'login', // the column DEFAULT, modelled
      }
      tokens.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      // `.is('used_at', null)` — the filter that makes single use real. Without
      // modelling it, two redemptions of one token both succeed and the
      // single-use test passes against a mock that cannot fail.
      const requiresUnused = params(url).get('used_at') === 'is.null'
      const target = tokens.find((t) => t.id === id && (!requiresUnused || t.used_at === null))
      if (target) Object.assign(target, body)
      return one(target ? [target] : [])
    }
    const token = eqParam(url, 'token')
    const rows = tokens
      .filter((t) => (token ? t.token === token : true))
      .map((t) => ({ ...t, users: users.find((u) => u.id === t.user_id) ?? null }))
    return singular ? one(rows) : json(rows)
  }

  return json([])
}) as typeof fetch

// ── call helpers ─────────────────────────────────────────────────────────────

async function callJson(handler: Handler, opts: { user?: string | null; method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  let status = 0
  let resBody: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { resBody = v; return res },
    end() { return res },
    redirect() { return res },
  }
  const headers: Record<string, string> = {}
  if (opts.user !== null) headers.authorization = `Bearer ${await createSessionToken(opts.user || ADMIN)}`
  await handler({ headers, method: opts.method || 'POST', body: opts.body, query: opts.query || {} } as any, res)
  return { status, body: resBody }
}

// callback.ts answers with redirects, never json.
async function redeem(token: string) {
  const { default: callback } = await import('../api/auth/callback')
  let location = ''
  const res: any = {
    setHeader() {},
    status(_c: number) { return res },
    json() { return res },
    end() { return res },
    redirect(a: any, b?: any) { location = String(b ?? a); return res },
  }
  await (callback as Handler)({ headers: {}, method: 'GET', query: { token } } as any, res)
  return location
}

function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token') || ''
}

;(async () => {
  const { default: membersIndex } = await import('../api/admin/members/index')
  const { default: membersBulk } = await import('../api/admin/members/bulk')
  const { default: sendMagicLink } = await import('../api/auth/send-magic-link')

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 1. create writes the row, and the invite redeems into a session --')
  {
    reset()
    const r = await callJson(membersIndex, { body: { name: 'Jane Doe', email: '  Jane.Doe@Example.COM ', membership_tier: 'workshop' } })
    ok('201', r.status === 201, String(r.status) + ' ' + JSON.stringify(r.body))

    // Asserted against the STORED ROW, not the response body — the response is
    // the thing under test, so trusting it to prove itself proves nothing.
    const stored = users.find((u) => u.email === 'jane.doe@example.com')
    ok('one row stored under the normalised email', !!stored)
    eq('tier is what was asked for', stored?.membership_tier, 'workshop')
    ok('no row kept the raw casing', !users.some((u) => u.email.includes('Jane')))

    ok('an invite was mailed', mailed.length === 1, JSON.stringify(mailed))
    const issued = tokens.find((t) => t.user_id === stored?.id)
    eq('and it is an invite, not a login link', issued?.kind, 'invite')

    // Redeemed for real: the acceptance is a WORKING session, not a 201.
    const location = await redeem(tokenFromLink(mailed[0].link))
    const session = new URL(location).searchParams.get('token') || ''
    const claims = await verifySessionToken(session)
    eq('redeeming yields a session for that member', claims?.userId, stored?.id)
    eq('stamped magic_link, so they can set a first password', claims?.origin, 'magic_link')
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 2. an existing email is a conflict, and writes nothing --')
  {
    reset()
    await callJson(membersIndex, { body: { name: 'Jane', email: 'jane@example.com', membership_tier: 'full' } })
    const before = users.length
    const mailedBefore = mailed.length

    // Differs only in case — the same person.
    const r = await callJson(membersIndex, { body: { name: 'Jane Again', email: 'JANE@example.com', membership_tier: 'workshop' } })
    eq('409', r.status, 409)
    eq('error names the collision', r.body?.error, 'member_exists')
    ok('and names the existing member', r.body?.existing?.email === 'jane@example.com', JSON.stringify(r.body))
    eq('row count unchanged', users.length, before)
    eq('their tier was NOT silently rewritten', users.find((u) => u.email === 'jane@example.com')?.membership_tier, 'full')
    eq('and nothing was mailed', mailed.length, mailedBefore)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 3. an invite outlives a login link (clock controlled) --')
  {
    reset()
    await callJson(membersIndex, { body: { name: 'Late Opener', email: 'late@example.com', membership_tier: 'workshop' } })
    const inviteLink = mailed[0].link

    // The CONTROL, and the reason this fixture can tell the difference: a login
    // link minted at the same instant for the same member. Only `kind` varies —
    // same table, same clock, same redemption path. If the invite passed and
    // nothing else were asserted, a 24-hour login link would pass too and the
    // test would prove nothing about the feature.
    mailed = []
    await callJson(sendMagicLink, { user: null, body: { email: 'late@example.com' } })
    const loginLink = mailed[0].link
    const loginToken = tokens.find((t) => t.token === tokenFromLink(loginLink))
    eq('the control is a login token', loginToken?.kind, 'login')

    fakeNow = REAL_NOW + 24 * 60 * 60 * 1000 // +24h

    const loginAfter = await redeem(tokenFromLink(loginLink))
    ok('the 15-minute login link is dead at +24h', loginAfter.includes('error=invalid_token'), loginAfter)

    const inviteAfter = await redeem(tokenFromLink(inviteLink))
    const session = new URL(inviteAfter).searchParams.get('token') || ''
    const claims = await verifySessionToken(session)
    ok('the invite still redeems at +24h', !!claims, inviteAfter)

    // The window is proven to END, so this is not "invites never expire".
    reset()
    await callJson(membersIndex, { body: { name: 'Way Late', email: 'waylate@example.com', membership_tier: 'workshop' } })
    const link = mailed[0].link
    fakeNow = REAL_NOW + INVITE_TTL_MS + 1000
    const expired = await redeem(tokenFromLink(link))
    ok('an invite past its window is refused', expired.includes('error=invite_expired'), expired)
    ok('and says invite_expired, not invalid_token, so the page can offer a resend', !expired.includes('error=invalid_token'))
    ok('invite lifetime is genuinely longer than login', INVITE_TTL_MS > LOGIN_TTL_MS)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 4. an invite is single use --')
  {
    reset()
    await callJson(membersIndex, { body: { name: 'Once', email: 'once@example.com', membership_tier: 'beta' } })
    const link = mailed[0].link

    const first = await redeem(tokenFromLink(link))
    ok('first redemption works', first.includes('auth-callback?token='), first)

    const second = await redeem(tokenFromLink(link))
    ok('second redemption is refused', second.includes('error=invalid_token'), second)
    eq('exactly one token row, and it is stamped used', tokens.filter((t) => t.used_at !== null).length, 1)
  }

  console.log('\n-- 4b. two SIMULTANEOUS clicks still mint one session --')
  {
    // The sequential test above is satisfied by the read-path check alone:
    // deleting the `.is('used_at', null)` filter from the claiming UPDATE left
    // it green, which made that filter a decorative guard. Two redemptions
    // racing past the read before either writes is the only thing that can tell
    // the difference — the read says "unused" to both, and only the conditional
    // update refuses the loser.
    reset()
    await callJson(membersIndex, { body: { name: 'Double Click', email: 'race@example.com', membership_tier: 'beta' } })
    const token = tokenFromLink(mailed[0].link)

    const [a, b] = await Promise.all([redeem(token), redeem(token)])
    const sessions = [a, b].filter((loc) => loc.includes('auth-callback?token='))
    const refusals = [a, b].filter((loc) => loc.includes('error=invalid_token'))

    eq('exactly one race winner', sessions.length, 1)
    eq('and exactly one refusal', refusals.length, 1)
    eq('one token row, stamped once', tokens.filter((t) => t.used_at !== null).length, 1)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 5. bulk: per-row outcomes, one write, no abort --')
  {
    reset()
    await callJson(membersIndex, { body: { name: 'Already Here', email: 'existing@example.com', membership_tier: 'full' } })
    const before = users.length
    mailed = []

    const r = await callJson(membersBulk, {
      body: {
        rows: [
          { name: 'New Person', email: 'new@example.com', membership_tier: 'workshop' },
          { name: 'Already Here', email: 'Existing@example.com', membership_tier: 'workshop' },
          { name: 'Bad Tier', email: 'badtier@example.com', membership_tier: 'platinum' },
          { name: 'Bad Email', email: 'not-an-email', membership_tier: 'workshop' },
        ],
      },
    })

    eq('200 even though rows failed', r.status, 200)
    eq('four results for four rows', r.body?.results?.length, 4)
    // Read through a helper rather than indexing directly: a handler that
    // ABANDONS the list after the first bad row returns three results, and
    // indexing the fourth would kill the process before the remaining
    // assertions ran — turning "one row's outcome is wrong" into a stack trace
    // that says nothing about which guarantee broke.
    const row = (i: number) => (r.body?.results?.[i] ?? {}) as any
    eq('row 1 created', row(0).outcome, 'created')
    eq('row 2 skipped as existing', row(1).outcome, 'skipped_existing')
    eq('row 3 rejected: tier', row(2).reason, 'invalid_tier')
    eq('row 4 rejected: email', row(3).reason, 'email_malformed')
    ok('every result carries its row index', (r.body?.results ?? []).every((x: any, i: number) => x.index === i))

    eq('exactly one row created', users.length, before + 1)
    ok('the bad rows did not abort the good one', !!users.find((u) => u.email === 'new@example.com'))

    // The summary is DERIVED from the results — assert it against them rather
    // than against a literal, so a hand-tallied counter cannot drift.
    const results = r.body.results as any[]
    eq('summary.created matches the rows', r.body.summary.created, results.filter((x) => x.outcome === 'created').length)
    eq('summary.rejected matches the rows', r.body.summary.rejected, results.filter((x) => x.outcome === 'rejected').length)
    eq('summary.total matches the rows', r.body.summary.total, results.length)

    // IDEMPOTENT: the same list again writes nothing.
    const countAfterFirst = users.length
    const again = await callJson(membersBulk, {
      body: {
        rows: [
          { name: 'New Person', email: 'new@example.com', membership_tier: 'workshop' },
          { name: 'Already Here', email: 'Existing@example.com', membership_tier: 'workshop' },
        ],
      },
    })
    eq('re-running creates nothing', users.length, countAfterFirst)
    ok('and reports both as existing', again.body.results.every((x: any) => x.outcome === 'skipped_existing'))
  }

  console.log('\n-- 5b. a duplicate INSIDE one payload is named as such --')
  {
    reset()
    const before = users.length
    const r = await callJson(membersBulk, {
      body: {
        rows: [
          { name: 'Twice', email: 'twice@example.com', membership_tier: 'beta' },
          { name: 'Twice Again', email: 'TWICE@example.com', membership_tier: 'beta' },
        ],
      },
    })
    eq('first created', r.body.results[0].outcome, 'created')
    eq('second rejected as an in-file duplicate', r.body.results[1].reason, 'duplicate_in_payload')
    ok('the message points at the earlier row', String(r.body.results[1].message).includes('row 1'), r.body.results[1].message)
    eq('one row written', users.length, before + 1)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 6. free is handled deliberately and the response says so --')
  {
    reset()
    const r = await callJson(membersIndex, { body: { name: 'Freebie', email: 'free@example.com', membership_tier: 'free' } })
    eq('201 — the member is created', r.status, 201)
    ok('the row exists', !!users.find((u) => u.email === 'free@example.com'))
    eq('no invite was sent', r.body.invite.sent, false)
    eq('and the reason is named, not implied', r.body.invite.reason, 'no_app_access')
    ok('the message states what happened in words', /app_login/.test(String(r.body.invite.message)), r.body.invite.message)
    eq('nothing was mailed', mailed.length, 0)
    eq('and no token was minted for an account that cannot use one', tokens.length, 0)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 7. no unauthenticated path creates a user --')
  {
    reset()

    // The endpoints themselves.
    const anon = await callJson(membersIndex, { user: null, body: { name: 'X', email: 'x@example.com', membership_tier: 'full' } })
    eq('POST /api/admin/members without a session is 401', anon.status, 401)
    const nonAdmin = await callJson(membersIndex, { user: NON_ADMIN, body: { name: 'X', email: 'x@example.com', membership_tier: 'full' } })
    eq('and 403 for a logged-in non-admin', nonAdmin.status, 403)
    const anonBulk = await callJson(membersBulk, { user: null, body: { rows: [] } })
    eq('bulk without a session is 401', anonBulk.status, 401)
    eq('nothing was written by any of them', users.length, 2)

    // send-magic-link must stay LOOKUP-ONLY. This is the guard enforcing "no
    // public sign-up", so it is asserted, not assumed.
    const before = users.length
    const r = await callJson(sendMagicLink, { user: null, body: { email: 'stranger@nowhere.test' } })
    eq('an unknown email still gets a neutral 200', r.status, 200)
    eq('no user was created from it', users.length, before)
    eq('and no token was minted', tokens.length, 0)
  }

  console.log('\n-- 7b. every users INSERT site in the tree is gated --')
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
    const files = [...walk('api'), ...walk('lib')]

    // Asserted by VALUE against a named list, not by counting. A count would
    // stay green when one gated writer is swapped for an ungated one.
    // STRIP COMMENTS, THEN match adjacency. Neither half alone works:
    //  - `.from('users')\s*.upsert(` misses api/members/create-free.ts, which
    //    carries a comment between the two lines. Shipped that way yesterday,
    //    so the sweep walked past a file that CREATES USERS and reported a
    //    clean list — evidence about the regex, not about the code.
    //  - "mentions users anywhere AND inserts anywhere" catches every handler
    //    that merely READS a user and writes some other table.
    // The question is "does this file insert into users", so ask exactly that.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    const inserters = files.filter((f) => {
      const src = stripComments(readFileSync(f, 'utf8'))
      return /\.from\(['"]users['"]\)\s*\.(insert|upsert)\(/.test(src)
    })

    // Every writer, grouped by the gate it ACTUALLY has, with that gate
    // asserted by value. The acceptance criterion says "confirm each call site
    // is admin-gated" — and three of these are not. They are not public sign-up
    // either: two require a shared secret header and one requires a valid
    // Stripe signature. Listing them without checking their gates would let a
    // future edit remove one and still pass, so each group asserts its own.
    const GATES: { file: string; mustContain: string[]; why: string }[] = [
      // Not a route. The write POST /api/admin/members and /bulk perform.
      { file: 'lib/memberInvite.ts', mustContain: [], why: 'library, reached only from the admin routes asserted below' },
      // The GoHighLevel webhooks that used to be here — create-free,
      // create-paid, invite-beta — were retired to 410 on 2026-08-07 and no
      // longer write users at all. Asserted below rather than listed here, so
      // un-retiring one fails this suite instead of quietly rejoining the set.
      // Stripe — signature verification, not a shared secret.
      { file: 'api/stripe/webhook.ts', mustContain: ['constructEvent', 'STRIPE_WEBHOOK_SECRET'], why: 'Stripe payment' },
    ]

    const known = GATES.map((g) => g.file)
    const unexpected = inserters.filter((f) => !known.includes(f))
    ok(
      'no users-insert site outside the audited list',
      unexpected.length === 0,
      `new writer(s) with an unaudited gate: ${unexpected.join(', ')}`
    )

    for (const g of GATES) {
      ok(`${g.file} still writes users (${g.why})`, inserters.includes(g.file), 'audited file no longer inserts — update the list')
      const src = readFileSync(g.file, 'utf8')
      for (const needle of g.mustContain) {
        ok(`  and is gated on ${needle}`, src.includes(needle), `${g.file} lost its gate`)
      }
    }

    // The distinction the acceptance criterion is really about: none of these
    // can be reached by an anonymous caller. Asserted as the ABSENCE of an
    // ungated writer rather than the presence of gated ones.
    for (const g of GATES.filter((x) => x.mustContain.length)) {
      const src = readFileSync(g.file, 'utf8')
      const gateAt = Math.min(...g.mustContain.map((n) => src.indexOf(n)).filter((i) => i >= 0))
      const writeAt = stripComments(src).search(/\.from\(['"]users['"]\)\s*\.(insert|upsert)\(/)
      ok(`  and gates BEFORE it writes`, gateAt >= 0 && writeAt > gateAt, `${g.file}: gate at ${gateAt}, write at ${writeAt}`)
    }

    // THE RETIRED FIVE MUST STAY RETIRED. GHL is disconnected; these answered
    // a shared secret and could create users, grant paid tiers and suspend
    // accounts. They now return 410 before any auth check, body parse or
    // database access. If one ever regains a write this fails, which is the
    // point — the capability is meant to be gone, not merely unused.
    for (const retiredRoute of [
      'api/members/create-free.ts',
      'api/members/create-paid.ts',
      'api/members/invite-beta.ts',
      'api/members/resume.ts',
      'api/members/suspend.ts',
    ]) {
      const src = readFileSync(retiredRoute, 'utf8')
      ok(`${retiredRoute} is retired to 410`, src.includes('respondGone'), 'a retired route regained a handler body')
      ok(`  and no longer appears in the users-insert set`, !inserters.includes(retiredRoute))
      ok(
        `  and reaches no table at all`,
        !/\.from\(['"][a-z_]+['"]\)/.test(stripComments(src)),
        'nothing may sit downstream of the 410 status line'
      )
    }

    // The routes that call createMember are the admin ones, by value.
    for (const route of ['api/admin/members/index.ts', 'api/admin/members/bulk.ts']) {
      const src = readFileSync(route, 'utf8')
      ok(`${route} calls requireAdmin`, src.includes('requireAdmin'))
      ok(`${route} gates before creating`, src.indexOf('requireAdmin') < src.indexOf('createMember'))
    }

    // And the guard comment that encodes the product decision is still there.
    const sml = readFileSync('api/auth/send-magic-link.ts', 'utf8')
    ok('send-magic-link still declares itself lookup-only', /do not create new users/i.test(sml))
    ok('and still contains no insert into users', !/\.from\(['"]users['"]\)\s*[\r\n\s]*\.(insert|upsert)\(/.test(sml))
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 8. one tier list, not two --')
  {
    const { readFileSync } = await import('fs')
    const idSrc = readFileSync('api/admin/members/[id].ts', 'utf8')
    ok('PATCH imports the shared list', idSrc.includes("from '../../../lib/entitlements'"))
    ok('and holds no local copy of it', !/const VALID_TIERS\s*=/.test(idSrc))

    // The shared list must match the production CHECK constraint, verified as
    // users_membership_tier_check. Pinned by value so widening one alone fails.
    eq('the list is the production vocabulary', [...MEMBERSHIP_TIERS], ['free', 'low_ticket', 'full', 'beta', 'workshop'])

    reset()
    const r = await callJson(membersIndex, { body: { name: 'Bad', email: 'bad@example.com', membership_tier: 'platinum' } })
    eq('create rejects an unknown tier', r.status, 400)
    eq('with the shared list in the message', r.body?.message, `membership_tier must be one of: ${MEMBERSHIP_TIERS.join(', ')}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n-- 9. suspended members are never handed a session --')
  {
    reset()
    await callJson(membersIndex, { body: { name: 'Suspended Soon', email: 'susp@example.com', membership_tier: 'full' } })
    const link = mailed[0].link
    const target = users.find((u) => u.email === 'susp@example.com')!
    target.status = 'suspended'

    const location = await redeem(tokenFromLink(link))
    ok('a live invite for a suspended account is refused', location.includes('error=account_suspended'), location)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
