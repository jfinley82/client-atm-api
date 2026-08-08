// THE FUNNEL PUBLIC HOST HAS ONE OWNER, AND IT AGREES WITH WHAT VERCEL ROUTES.
//
// api/funnels/[id]/publish.ts hardcoded `microtrainingmethod.com` while the
// other seven sites read FUNNEL_PUBLIC_DOMAIN, defaulting to
// freeminiworkshop.com. That is not two spellings of the same place:
// charge-demo.freeminiworkshop.com serves the live funnel, and
// charge-demo.microtrainingmethod.com is NXDOMAIN — no wildcard, and none
// coming, since that apex now serves the marketing site. So the URL a coach was
// handed the moment they pressed Publish resolved to nothing at all.
//
// ASSERTED ON THE BUILT URL, NOT ON THE CONSTANT. The publish handler is driven
// with a real funnel row whose subdomain is charge-demo — the live production
// subdomain, not an invented one — and the expected string is written out
// independently below rather than derived from the code under test. That is the
// difference between a test that would have failed on main and one that agrees
// with whatever the module currently says.
//
// The env-var half lives in tests/funnelDomainEnv.test.ts, because the value is
// captured at module load and one process cannot hold both the default and an
// override.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
delete process.env.FUNNEL_PUBLIC_DOMAIN

import fs from 'fs'
import path from 'path'
import { projectSelect } from './support/postgrest'

// WRITTEN OUT, NOT DERIVED. Both of these are facts about production measured
// outside this repo: charge-demo is the one live funnel, and it answers on
// freeminiworkshop.com. If the code stops agreeing with them, the code is wrong.
const LIVE_SUBDOMAIN = 'charge-demo'
const LIVE_URL = 'https://charge-demo.freeminiworkshop.com'
const DEAD_DOMAIN = 'microtrainingmethod.com'

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

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const USER_ID = '11111111-1111-4111-8111-111111111111'
const FUNNEL_ID = '22222222-2222-4222-8222-222222222222'

const FUNNEL_ROW = {
  id: FUNNEL_ID,
  user_id: USER_ID,
  subdomain: LIVE_SUBDOMAIN,
  status: 'live',
  published_at: '2026-07-01T00:00:00.000Z',
  // Must satisfy landingPageHasCopy or publish refuses with `not_ready` — a
  // headline, a subheadline and exactly three of each bullet list.
  landing_page: {
    headline: 'A free training',
    subheadline: 'Thirty minutes, no pitch',
    problem_bullets: ['One', 'Two', 'Three'],
    solution_bullets: ['Four', 'Five', 'Six'],
    cta_label: 'Watch it',
  },
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (url.includes('/rest/v1/users')) {
    return json({ id: USER_ID, membership_tier: 'full', role: 'member', add_ons: {}, status: 'active' })
  }
  if (url.includes('/rest/v1/funnels')) {
    // generateFunnelCovers re-reads the funnel with its own much wider select
    // (generation_id is unique to it) before launching headless Chromium.
    // Answering that one with null makes it throw at the top, which publish
    // catches by design — the covers are best-effort and must never turn a
    // successful publish into a 500. This keeps a browser out of the gate
    // without stubbing the function itself.
    if (url.includes('generation_id')) return json(null)
    return json(FUNNEL_ROW)
  }
  return json([])
}) as typeof fetch

function callPublish(token: string) {
  let status = 0
  let body: any = null
  const res: any = {
    setHeader() {},
    status(c: number) {
      status = c
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
  const req: any = {
    method: 'POST',
    url: `/api/funnels/${FUNNEL_ID}/publish`,
    headers: { authorization: `Bearer ${token}`, origin: 'https://app.microtrainingmethod.com' },
    query: { id: FUNNEL_ID },
    body: {},
  }
  return { res, req, status: () => status, body: () => body }
}

;(async () => {
  const { createSessionToken } = await import('../lib/auth')
  const token = await createSessionToken(USER_ID)

  console.log('\n-- publish returns the URL the funnel is actually served on --')
  {
    const c = callPublish(token)
    const { default: publish } = await import('../api/funnels/[id]/publish')
    await publish(c.req, c.res)

    eq('publish succeeds', c.status(), 200)
    // THE ASSERTION THAT WOULD HAVE FAILED ON MAIN. Before this change the
    // handler answered https://charge-demo.microtrainingmethod.com, which is
    // NXDOMAIN — a coach copying it out of the success toast got a DNS error.
    eq('and the URL is the live host', c.body()?.url, LIVE_URL)
    ok(
      'not the dead one',
      typeof c.body()?.url === 'string' && !c.body().url.includes(DEAD_DOMAIN),
      `got ${c.body()?.url}`
    )
  }

  console.log('\n-- the serving-host reader answers the same domain --')
  {
    // trainingPage renders the funnel's own copy through escapeWithLinks, which
    // builds the visible `<sub>.<domain>/…` label from the serving host. This is
    // the OTHER reader — the one that decides what a lead sees on the page — and
    // it is executed here rather than inspected.
    const { trainingPage } = await import('../api/funnels/render')
    const { brandKit } = await import('../lib/brandKit')
    const branding = {
      brand: brandKit({} as any),
      head: '',
      logoUrl: null,
      headshotUrl: null,
      businessName: null,
      legal: {},
      cookieNotice: false,
    }
    const html = trainingPage(
      { subdomain: LIVE_SUBDOMAIN, training_page: { headline: 'Book here: [BOOK_A_CALL_LINK]' } },
      branding as any,
      []
    )
    ok('the rendered label carries the live host', html.includes('charge-demo.freeminiworkshop.com'), html.slice(0, 400))
    ok('and never the dead one', !html.includes(DEAD_DOMAIN), 'the page advertises a host with no DNS record')
  }

  console.log('\n-- publish and vercel.json name the same domain --')
  {
    // TWO ARTIFACTS, ASSERTED AGAINST EACH OTHER rather than each against a
    // constant. vercel.json is static JSON: it cannot read FUNNEL_PUBLIC_DOMAIN,
    // so the env var does not MOVE the funnels — it is the value that has to
    // stay equal to what vercel.json routes. When they disagree we advertise an
    // address nothing answers on, which is the whole defect this file is about.
    const vercelJson = read('vercel.json')
    const routed = new Set<string>()
    for (const m of vercelJson.matchAll(/"type":\s*"host",\s*"value":\s*"([^"]+)"/g)) {
      // `([^.]+)\\.freeminiworkshop\\.com` -> freeminiworkshop.com
      // The value is a regex inside JSON, so the raw text carries escaped dots
      // and an optional subdomain group. Strip both to get the apex it routes.
      const apex = m[1].replace(/\\/g, '').replace(/^\(\[\^\.\]\+\)\./, '').replace(/^www\./, '')
      routed.add(apex)
    }
    eq('vercel.json routes exactly one apex', [...routed], ['freeminiworkshop.com'])

    const publishedHost = new URL(LIVE_URL).host
    ok(
      'and the published URL sits under it',
      publishedHost.endsWith(`.${[...routed][0]}`),
      `${publishedHost} is not under ${[...routed][0]}`
    )
  }

  console.log('\n-- neither domain literal appears as a funnel host outside the owner --')
  {
    const OWNER = 'lib/funnelDomain.ts'
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) sources.push(p)
      }
    }
    walk('api')
    walk('lib')

    // CODE ONLY, COMMENTS EXEMPT. Five files mention freeminiworkshop.com in
    // prose — funnels.ts explaining why `www` is a reserved slug, email.ts
    // explaining why the base domain is never shown as visible text. Naming the
    // domain while explaining a rule about it is the opposite of the defect; what
    // may not exist is a second file that BUILDS a host from the literal.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const funnelLiteral = sources.filter(
      (f) => f !== OWNER && stripComments(read(f)).includes('freeminiworkshop.com')
    )
    eq('freeminiworkshop.com lives only in the owner', funnelLiteral, [])

    // microtrainingmethod.com is a different matter: app.microtrainingmethod.com
    // is the member app and api.* was considered for the API, so the bare string
    // is legitimate in lib/appUrls.ts. What may not exist anywhere is a funnel
    // host built on it — a subdomain interpolated in front of it.
    const asFunnelHost = sources.filter((f) => {
      const src = read(f)
      return /\$\{[^}]*\}\.(?:\$\{[^}]*\}|)?microtrainingmethod\.com/.test(src) || /const FUNNEL_DOMAIN\s*=/.test(src)
    })
    eq('no file builds a funnel host on microtrainingmethod.com', asFunnelHost, [])

    // And the shape that started this: a second declaration of the domain.
    const declarers = sources.filter((f) => f !== OWNER && /process\.env\.FUNNEL_PUBLIC_DOMAIN/.test(read(f)))
    eq('FUNNEL_PUBLIC_DOMAIN is read in exactly one place', declarers, [])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
