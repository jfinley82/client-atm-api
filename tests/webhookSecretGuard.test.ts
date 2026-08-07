process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.STRIPE_SECRET_KEY = 'sk_test_stub'

import crypto from 'crypto'
import { Readable } from 'stream'

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

// THE ASSERTION THAT MATTERS for the retired routes. Not the status code — a
// handler that answered 410 after suspending the member would satisfy that.
// This counts every write that reached the database layer, so what is under
// test is "the capability is gone", not "the status line changed".
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
  if (url.includes('api.resend.com')) return json({ id: 'msg-stub' })
  return json([])
}) as typeof fetch

// Capture the deprecation log so its CONTENTS can be asserted — one line per
// call, the caller's identifiers present, the secret absent.
let warnings: string[] = []
const realWarn = console.warn
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
}

function call(handler: Handler, opts: { method?: string; headers?: Record<string, string>; body?: unknown; req?: any } = {}) {
  let status = 0
  let resBody: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { resBody = v; return res },
    end() { return res },
    redirect() { return res },
  }
  const req: any = opts.req ?? {
    method: opts.method || 'POST',
    url: '/api/stub',
    headers: opts.headers || {},
    body: opts.body ?? {},
    query: {},
    on() {},
  }
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: resBody }))
}

const SECRET = 'the-real-secret-value-abc123'
const REMOVE_AFTER = '2026-08-21'

;(async () => {
  const [createFree, createPaid, inviteBeta, resume, suspend] = await Promise.all([
    import('../api/members/create-free'),
    import('../api/members/create-paid'),
    import('../api/members/invite-beta'),
    import('../api/members/resume'),
    import('../api/members/suspend'),
  ])

  const retired: { name: string; handler: Handler }[] = [
    { name: 'create-free', handler: createFree.default as Handler },
    { name: 'create-paid', handler: createPaid.default as Handler },
    { name: 'invite-beta', handler: inviteBeta.default as Handler },
    { name: 'resume', handler: resume.default as Handler },
    { name: 'suspend', handler: suspend.default as Handler },
  ]

  // EVERY method, with no carve-out. There is deliberately no setCors on these,
  // so OPTIONS does not short-circuit to 204 either — the whole surface is 410.
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

  console.log('\n-- retired: 410 to every method, and nothing written --')
  {
    process.env.WEBHOOK_SECRET = SECRET

    for (const { name, handler } of retired) {
      for (const method of METHODS) {
        writes = []
        warnings = []
        const r = await call(handler, { method, headers: { 'x-webhook-secret': SECRET }, body: { email: 'x@example.com' } })
        eq(`  ${name} ${method} -> 410`, r.status, 410)
        eq(`  ${name} ${method} wrote nothing`, writes, [])
      }
    }
  }

  console.log('\n-- a VALID secret gets 410 too: the capability is gone, not gated --')
  {
    // The case that separates "retired" from "still working, just stricter".
    // A caller holding the real credential is refused, because there is no
    // longer anything behind the door.
    process.env.WEBHOOK_SECRET = SECRET
    for (const { name, handler } of retired) {
      writes = []
      const r = await call(handler, {
        method: 'POST',
        headers: { 'x-webhook-secret': SECRET },
        body: { email: 'x@example.com', tier: 'full' },
      })
      eq(`  ${name} refuses a correctly authenticated POST`, r.status, 410)
      eq(`  ${name} says gone`, r.body?.error, 'gone')
      eq(`  ${name} carries its removal date`, r.body?.remove_after, REMOVE_AFTER)
      eq(`  ${name} wrote nothing`, writes, [])
    }
  }

  console.log('\n-- and with the secret UNSET, which is the state it is now in --')
  {
    delete process.env.WEBHOOK_SECRET
    for (const { name, handler } of retired) {
      writes = []
      const r = await call(handler, { method: 'POST', body: { email: 'x@example.com' } })
      eq(`  ${name} still 410, never 500 or 200`, r.status, 410)
      eq(`  ${name} wrote nothing`, writes, [])
    }
  }

  console.log('\n-- one log line per call, with the caller and without the secret --')
  {
    process.env.WEBHOOK_SECRET = SECRET
    for (const { name, handler } of retired) {
      warnings = []
      await call(handler, {
        method: 'POST',
        headers: {
          'x-webhook-secret': SECRET,
          'x-forwarded-for': '203.0.113.7, 70.41.3.18',
          'user-agent': 'GHL-Workflow/2.1',
        },
        body: { email: 'x@example.com' },
      })

      eq(`  ${name} logs exactly once`, warnings.length, 1)
      const line = warnings[0] || ''
      ok(`  ${name} line is findable`, line.includes('[deprecated-410]'), line)
      ok(`  ${name} names the route`, line.includes(name), line)
      ok(`  ${name} carries the method`, line.includes('POST'), line)
      ok(`  ${name} carries the client IP, not the proxy chain`, line.includes('203.0.113.7') && !line.includes('70.41.3.18'), line)
      ok(`  ${name} carries the user agent`, line.includes('GHL-Workflow/2.1'), line)
      ok(`  ${name} records that a secret header was PRESENT`, line.includes('"webhook_secret_header":"present"'), line)

      // THE ONE THAT MATTERS. Asserted by VALUE against the actual secret, not
      // by a shape like "no long hex string" — a log is where a credential
      // outlives the system that used it.
      ok(`  ${name} does NOT log the secret itself`, !line.includes(SECRET), 'THE SECRET IS IN THE LOG')
    }

    // Absence is reported too, so the two cases are distinguishable — "nobody
    // is calling" and "something is calling without credentials" are different
    // situations and the log has to tell them apart.
    warnings = []
    await call(retired[0].handler, { method: 'POST', headers: {}, body: {} })
    ok('  a call with no secret header is recorded as absent', (warnings[0] || '').includes('"webhook_secret_header":"absent"'), warnings[0])
  }

  console.log('\n-- WEBHOOK_SECRET is now read by nothing --')
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

    // Comments stripped first: lib/webhookAuth.ts still DESCRIBES the variable
    // in the note explaining why the file is parked, and a naive grep would
    // count that as a reader. The question is whether any code reads it.
    const readers = [...walk('api'), ...walk('lib')].filter((f) => {
      const src = stripComments(readFileSync(f, 'utf8'))
      return /process\.env\.WEBHOOK_SECRET/.test(src)
    })

    // lib/webhookAuth.ts is unreferenced but deliberately kept until the
    // removal date, so restoring an endpoint is a revert rather than a rewrite.
    eq('the only file left holding it is the parked gate', readers, ['lib/webhookAuth.ts'])

    const importers = [...walk('api'), ...walk('lib')].filter((f) => {
      const src = stripComments(readFileSync(f, 'utf8'))
      return src.includes('requireWebhookSecret') && !f.endsWith('webhookAuth.ts')
    })
    eq('and nothing imports it any more', importers, [])
  }

  console.log('\n-- STRIPE: unchanged, and the one that was actually serious --')
  {
    const { default: stripeHandler } = await import('../api/stripe/webhook')

    const streamReq = (payload: string, sig: string) => {
      const s: any = Readable.from([Buffer.from(payload)])
      s.method = 'POST'
      s.url = '/api/stripe/webhook'
      s.headers = { 'stripe-signature': sig }
      s.query = {}
      return s
    }

    const payload = JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { object: {} } })
    const ts = Math.floor(Date.now() / 1000)
    const forged = crypto.createHmac('sha256', '').update(`${ts}.${payload}`).digest('hex')

    for (const variant of ['unset', 'empty string'] as const) {
      if (variant === 'unset') delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = ''

      writes = []
      const r = await call(stripeHandler as Handler, { req: streamReq(payload, `t=${ts},v1=${forged}`) })
      eq(`  [${variant}] a forged event is refused`, r.status, 500)
      eq(`  [${variant}] and says misconfigured`, r.body?.error, 'webhook_not_configured')
      eq(`  [${variant}] and nothing was written`, writes, [])
    }

    // The forgery is real, so the guard defends something real rather than an
    // imagined attack.
    const Stripe = (await import('stripe')).default
    const s = new Stripe('sk_test_stub')
    let accepted = false
    try {
      s.webhooks.constructEvent(payload, `t=${ts},v1=${forged}`, '')
      accepted = true
    } catch {
      accepted = false
    }
    ok('  the forged signature IS valid against an empty key', accepted, 'if this fails the guard is defending nothing')

    // THE POSITIVE CONTROL. Without it, "refuse every Stripe event always"
    // passes everything above — and that would silently stop paid grants, which
    // is a worse outcome than the hole being fixed.
    const realSecret = 'whsec_' + crypto.randomBytes(16).toString('hex')
    process.env.STRIPE_WEBHOOK_SECRET = realSecret
    const benign = JSON.stringify({ id: 'evt_ok', type: 'customer.updated', data: { object: {} } })
    const goodSig = crypto.createHmac('sha256', realSecret).update(`${ts}.${benign}`).digest('hex')

    writes = []
    const okRes = await call(stripeHandler as Handler, { req: streamReq(benign, `t=${ts},v1=${goodSig}`) })
    eq('  a correctly signed event is ACCEPTED', okRes.status, 200)
    eq('  and acknowledged', okRes.body?.received, true)
  }

  console.log('\n-- docs/ROUTES.md lists the retired routes rather than dropping them --')
  {
    const { spawnSync } = await import('child_process')
    const { existsSync, readFileSync } = await import('fs')

    ok('docs/ROUTES.md is committed', existsSync('docs/ROUTES.md'))

    const check = spawnSync('node', ['scripts/webhook-routes.mjs', '--check'], { cwd: process.cwd(), encoding: 'utf8' })
    ok(
      'and regenerating it produces no change',
      check.status === 0,
      (check.stdout || '') + (check.stderr || '') + '\n      run: node scripts/webhook-routes.mjs'
    )

    const doc = readFileSync('docs/ROUTES.md', 'utf8')

    // Listed, by value, WITH the date. A dropped row would read as "never
    // existed", which is the same class of wrong label that started all this.
    for (const route of ['create-free', 'create-paid', 'invite-beta', 'resume', 'suspend']) {
      ok(`  ${route} is listed as retired`, doc.includes(`/api/members/${route}`), 'a dropped row reads as never existed')
    }
    const dated = (doc.match(new RegExp(REMOVE_AFTER, 'g')) || []).length
    eq('  each retired route carries the removal date', dated, 5)

    ok('  the 410 is stated, not implied', /410 Gone/.test(doc))
    ok('  and WEBHOOK_SECRET is recorded as unused', /read by \*\*nothing\*\*/.test(doc))

    // The three still-live webhooks must not have been swept away with them.
    for (const live of ['/api/stripe/webhook', '/api/webhooks/resend', '/api/zoom/webhook']) {
      ok(`  ${live} is still listed as active`, doc.includes(live))
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  console.warn = realWarn
  if (fail) process.exit(1)
})()
