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

// THE ASSERTION THAT MATTERS. Not "what status came back" — a handler that
// answered 500 after already suspending the member would satisfy that. This
// counts every write that reached the database layer, so the property under
// test is literally "no request reaches a user-mutating handler".
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
    // Every read answers "found nothing", so a handler that got past the gate
    // still cannot pretend it succeeded — it fails on its own terms and the
    // write counter stays honest either way.
    return json(null)
  }
  if (url.includes('api.resend.com')) return json({ id: 'msg-stub' })
  return json([])
}) as typeof fetch

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
    headers: opts.headers || {},
    body: opts.body ?? {},
    query: {},
    on() {},
  }
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: resBody }))
}

const SECRET = 'the-real-secret'

;(async () => {
  // Literal specifiers, not a loop over path strings: esbuild can only inline
  // an import it can see statically, and a computed one stays a runtime import
  // resolved relative to the BUNDLE rather than the source tree.
  const [createFree, createPaid, inviteBeta, resume, suspend] = await Promise.all([
    import('../api/members/create-free'),
    import('../api/members/create-paid'),
    import('../api/members/invite-beta'),
    import('../api/members/resume'),
    import('../api/members/suspend'),
  ])

  const loaded: { name: string; handler: Handler; body: unknown }[] = [
    { name: 'create-free', handler: createFree.default as Handler, body: { email: 'x@example.com', first_name: 'X' } },
    { name: 'create-paid', handler: createPaid.default as Handler, body: { email: 'x@example.com', first_name: 'X', tier: 'full' } },
    { name: 'invite-beta', handler: inviteBeta.default as Handler, body: { email: 'x@example.com', first_name: 'X' } },
    { name: 'resume', handler: resume.default as Handler, body: { email: 'x@example.com' } },
    { name: 'suspend', handler: suspend.default as Handler, body: { email: 'x@example.com' } },
  ]

  console.log('\n-- THE PROPERTY: an absent secret refuses, it does not open --')
  {
    // Stated as the property rather than the example: this is not "a wrong
    // secret is rejected", which passed before the fix and after it. It is
    // "the gate is absent, therefore nothing gets through" — the case where
    // `undefined !== undefined` used to evaluate false and admit everyone.
    for (const variant of ['unset', 'empty string'] as const) {
      console.log(`  [WEBHOOK_SECRET ${variant}]`)
      for (const { name, handler, body } of loaded) {
        if (variant === 'unset') delete process.env.WEBHOOK_SECRET
        else process.env.WEBHOOK_SECRET = ''

        writes = []
        // The header is deliberately ABSENT, which is exactly what an
        // unauthenticated caller sends. Before the fix this matched the
        // undefined env var and sailed through.
        const r = await call(handler, { body })

        eq(`    ${name} refuses`, r.status, 500)
        eq(`    ${name} says it is misconfigured, not that the caller is wrong`, r.body?.error, 'webhook_not_configured')
        eq(`    ${name} wrote NOTHING`, writes, [])
      }
    }
  }

  console.log('\n-- and an attacker who sends undefined-as-a-header gets nowhere either --')
  {
    delete process.env.WEBHOOK_SECRET
    for (const { name, handler, body } of loaded) {
      writes = []
      // The literal string 'undefined' is what a naive client sends when its
      // own config is missing, and it is the shape that would match a
      // stringified env var.
      const r = await call(handler, { headers: { 'x-webhook-secret': 'undefined' }, body })
      eq(`    ${name} still refuses`, r.status, 500)
      eq(`    ${name} still wrote nothing`, writes, [])
    }
  }

  console.log('\n-- the gate still WORKS when configured: wrong secret is 401, right secret passes --')
  {
    // Without this, "refuse everything always" would pass every test above.
    // The fixture has to be able to tell a fixed gate from a broken one.
    process.env.WEBHOOK_SECRET = SECRET

    for (const { name, handler, body } of loaded) {
      writes = []
      const wrong = await call(handler, { headers: { 'x-webhook-secret': 'not-it' }, body })
      eq(`    ${name} rejects a wrong secret as a CLIENT error`, wrong.status, 401)
      eq(`    ${name} wrote nothing`, writes, [])
    }

    for (const { name, handler, body } of loaded) {
      writes = []
      const right = await call(handler, { headers: { 'x-webhook-secret': SECRET }, body })
      ok(
        `    ${name} lets a correct secret THROUGH the gate`,
        right.status !== 401 && right.status !== 500 ? true : writes.length > 0,
        `status ${right.status}, writes ${JSON.stringify(writes)} — if this fails the "fix" is just refusing everyone`
      )
    }
  }

  console.log('\n-- a GET is refused on the method, which is what made these look unguarded --')
  {
    process.env.WEBHOOK_SECRET = SECRET
    for (const { name, handler } of loaded) {
      writes = []
      const r = await call(handler, { method: 'GET' })
      eq(`    ${name} answers 405 to a GET`, r.status, 405)
      eq(`    ${name} wrote nothing`, writes, [])
    }
    ok(
      '    405-before-401 is the reason a GET probe reads as "method rejected, caller not"',
      true,
      'documented so the next reader does not re-raise it as a vulnerability'
    )
  }

  console.log('\n-- STRIPE: the same hole, and the one that grants paid access --')
  {
    const { default: stripeHandler } = await import('../api/stripe/webhook')

    // An EMPTY secret is not equivalent to a missing one for Stripe: its
    // library does not throw, it verifies against an HMAC keyed on '', which
    // anybody can compute. Verified here rather than asserted — this forges a
    // payment_intent.succeeded exactly as an attacker would.
    const payload = JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { object: {} } })
    const ts = Math.floor(Date.now() / 1000)
    const forged = crypto.createHmac('sha256', '').update(`${ts}.${payload}`).digest('hex')

    for (const variant of ['unset', 'empty string'] as const) {
      if (variant === 'unset') delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = ''

      writes = []
      // A REAL readable stream, because api/stripe/webhook.ts reads the raw
      // body off req before verifying. A plain object with a no-op `on()`
      // makes getRawBody wait forever, so removing the guard produced a HANG
      // rather than a failure — and a hang is indistinguishable from a slow
      // test. With a real stream the mutation shows the actual exploit: the
      // forged event verifies and the handler writes.
      const stream: any = Readable.from([Buffer.from(payload)])
      stream.method = 'POST'
      stream.headers = { 'stripe-signature': `t=${ts},v1=${forged}` }
      stream.query = {}
      const r = await call(stripeHandler as Handler, { req: stream })
      eq(`    [${variant}] a forged event is refused`, r.status, 500)
      eq(`    [${variant}] and says misconfigured`, r.body?.error, 'webhook_not_configured')
      eq(`    [${variant}] and nothing was written`, writes, [])
    }

    // Proof the forgery is real, so the guard above is not defending against
    // an imaginary attack: with an empty key the signature genuinely verifies.
    const Stripe = (await import('stripe')).default
    const s = new Stripe('sk_test_stub')
    let accepted = false
    try {
      s.webhooks.constructEvent(payload, `t=${ts},v1=${forged}`, '')
      accepted = true
    } catch {
      accepted = false
    }
    ok('    the forged signature IS valid against an empty key', accepted, 'if this fails the guard is defending nothing')
  }

  console.log('\n-- the property, swept: no secret-gated writer may skip the check --')
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

    // Routes that authenticate their CALLER with a shared secret or signature
    // and then write. Detected by the env var naming an inbound webhook, or by
    // delegating to the shared helper — NOT by the word "SECRET", which also
    // matches STRIPE_SECRET_KEY in api/stripe/create-intent.ts. That one is an
    // outbound API credential on a deliberately public checkout endpoint, so
    // "refuses when its secret is missing" is the wrong question to ask of it;
    // an earlier version of this sweep asked it anyway and failed on correct
    // code. Recorded so it does not get re-added.
    //
    // Swept rather than listed, so a SIXTH such file added tomorrow is caught
    // instead of inheriting the old two-line mistake. The five that prompted
    // this change were named in a brief; api/stripe/webhook.ts was not, and it
    // was the worst of them.
    const suspects = walk('api').filter((f) => {
      const src = readFileSync(f, 'utf8')
      const authenticatesCaller =
        /process\.env\.[A-Z_]*WEBHOOK[A-Z_]*/.test(src) || src.includes('requireWebhookSecret')
      // NOT an adjacency match. api/members/create-free.ts carries a comment
      // between .from('users') and .upsert(, and a `\s*`-joined pattern skips
      // it silently — which is how an earlier version of this sweep reported
      // seven files when there were eight. Ask the question the predicate is
      // actually about: does this file write to the database at all?
      const writes = /\.from\(['"][a-z_]+['"]\)/.test(src) && /\.(insert|upsert|update|delete)\(/.test(src)
      return authenticatesCaller && writes
    })

    // By value, naming every file the property must hold for. A count would
    // stay green if one dropped out and another appeared.
    const EXPECTED = [
      'api/members/create-free.ts',
      'api/members/create-paid.ts',
      'api/members/invite-beta.ts',
      'api/members/resume.ts',
      'api/members/suspend.ts',
      'api/stripe/webhook.ts',
      'api/webhooks/resend.ts',
      'api/zoom/webhook.ts',
    ]
    for (const f of EXPECTED) ok(`the sweep sees ${f}`, suspects.includes(f), `swept: ${suspects.join(', ')}`)
    const surprises = suspects.filter((f) => !EXPECTED.includes(f))
    ok('and finds nothing unaccounted for', surprises.length === 0, `new secret-gated writer(s): ${surprises.join(', ')}`)

    for (const f of suspects) {
      const src = readFileSync(f, 'utf8')
      // Either it delegates to the shared guard, or it refuses on a falsy
      // secret itself (the shape api/zoom/webhook.ts and api/webhooks/resend.ts
      // already used, and the shape this change gave the rest).
      const delegates = src.includes('requireWebhookSecret')
      const guardsInline = /if \(!\s*(secret|webhookSecret|secretToken)\s*\)/.test(src)
      ok(`  ${f} refuses when its secret is missing`, delegates || guardsInline, 'a bare !== comparison opens when the env var is unset')

      // And the comparison is never made directly against process.env, which
      // is the exact shape that reduces to undefined !== undefined.
      ok(
        `  ${f} never compares a header straight to process.env`,
        !/req\.headers\[[^\]]+\]\s*!==\s*process\.env\./.test(src),
        'compare against a value already proven non-empty'
      )
    }
  }

  console.log('\n-- docs/ROUTES.md is generated, so its labels cannot drift --')
  {
    const { spawnSync } = await import('child_process')
    const { existsSync, readFileSync } = await import('fs')

    ok('docs/ROUTES.md is committed', existsSync('docs/ROUTES.md'))

    // The assertion that matters: regenerate from the real handlers and compare.
    // The previous table said PUBLIC for five routes that had never been public,
    // and nothing could tell. This can.
    const check = spawnSync('node', ['scripts/webhook-routes.mjs', '--check'], { cwd: process.cwd(), encoding: 'utf8' })
    ok(
      'and regenerating it produces no change',
      check.status === 0,
      (check.stdout || '') + (check.stderr || '') + '\n      run: node scripts/webhook-routes.mjs'
    )

    const doc = readFileSync('docs/ROUTES.md', 'utf8')
    // By value, not by count: the five that were mislabelled must each appear,
    // and the word that was wrong about them must not.
    for (const route of ['create-free', 'create-paid', 'invite-beta', 'resume', 'suspend']) {
      ok(`  ${route} is listed with its gate`, doc.includes(`/api/members/${route}`))
    }
    ok('  and nothing in it is labelled PUBLIC', !/\bPUBLIC\b/.test(doc.replace(/None of these is public/i, '')))
    ok('  the 405-on-GET trap is explained', /405/.test(doc) && /method check runs before/i.test(doc))
    ok('  and the scope is stated rather than implied', /not an inventory of every route/i.test(doc))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
