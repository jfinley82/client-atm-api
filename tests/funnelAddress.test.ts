// THE FUNNEL'S ADDRESS IS SERVED, NOT COMPOSED BY THE CALLER.
//
// Nothing on the read endpoints carried it, so the frontend built
// `<subdomain>.<literal>` itself — a domain literal in a second repo, which is
// the disease lib/funnelDomain.ts was created to cure with one fewer copy.
//
// The assertions that matter here are the ones ACROSS producers. publish's
// `url`, the detail endpoint's `public_url`, the portfolio row's `public_url`
// and the host the public page renders are four independent code paths that
// must agree byte for byte, and comparing each to a string in this file would
// let all four drift together while every assertion stayed green. So they are
// compared to EACH OTHER, and only then to what vercel.json actually routes.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
delete process.env.FUNNEL_PUBLIC_DOMAIN

import fs from 'fs'
import path from 'path'
import { projectSelect } from './support/postgrest'

const LIVE_SUBDOMAIN = 'charge-demo'

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
const FUNNEL_ID = '22222222-2222-4222-8222-222222222222'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'

const LANDING = {
  headline: 'A free training',
  subheadline: 'Thirty minutes, no pitch',
  problem_bullets: ['One', 'Two', 'Three'],
  solution_bullets: ['Four', 'Five', 'Six'],
  cta_label: 'Watch it',
}

const LIVE_ROW = {
  id: FUNNEL_ID,
  user_id: USER_ID,
  subdomain: LIVE_SUBDOMAIN,
  status: 'live',
  published_at: '2026-07-01T00:00:00.000Z',
  problem_solution_label: 'Charge what you are worth',
  landing_page: LANDING,
}

// A DRAFT WITH NO SUBDOMAIN. Its address does not exist, and the endpoints must
// say so with null rather than with '' or a bare host — an empty string
// interpolates into href="" and renders as a link to the current page.
const DRAFT_ROW = {
  id: DRAFT_ID,
  user_id: USER_ID,
  subdomain: null,
  status: 'draft',
  published_at: null,
  problem_solution_label: 'Untitled',
  landing_page: LANDING,
}

// Which funnel rows the stub hands back. Swapped per case rather than keyed off
// the query, so a case cannot accidentally read the other case's fixture.
let funnelRows: any[] = [LIVE_ROW]
let singleFunnel: any = LIVE_ROW

globalThis.fetch = (async (input: any) => {
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
    // generateFunnelCovers re-reads with its own much wider select before
    // launching headless Chromium; null makes it throw at the top, which publish
    // catches by design. Keeps a browser out of the gate.
    if (url.includes('generation_id')) return json(null)
    // The portfolio's list read filters on user_id alone; the detail and publish
    // reads filter on the funnel id.
    //
    // ANCHORED. `url.includes('id=eq.')` is true of `user_id=eq.<uuid>` as well,
    // so the naive check routed the LIST query to the single-row fixture and the
    // handler got an object where it expected an array. The param boundary is
    // the thing being matched, so it has to be in the pattern.
    const byId = /[?&]id=eq\./.test(url)
    return json(byId ? singleFunnel : funnelRows)
  }
  return json([])
}) as typeof fetch

function callJson(method: string, url: string, query: Record<string, any>, token: string) {
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
    method,
    url,
    headers: { authorization: `Bearer ${token}`, origin: 'https://app.microtrainingmethod.com' },
    query,
    body: {},
  }
  return { req, res, status: () => status, body: () => body }
}

;(async () => {
  const { createSessionToken } = await import('../lib/auth')
  const token = await createSessionToken(USER_ID)

  const { default: publish } = await import('../api/funnels/[id]/publish')
  const { default: detail } = await import('../api/funnels/[id]/index')
  const { default: portfolio } = await import('../api/funnels/portfolio')

  // ---- the four producers, driven once each ---------------------------------
  funnelRows = [LIVE_ROW]
  singleFunnel = LIVE_ROW

  const pub = callJson('POST', `/api/funnels/${FUNNEL_ID}/publish`, { id: FUNNEL_ID }, token)
  await publish(pub.req, pub.res)

  const det = callJson('GET', `/api/funnels/${FUNNEL_ID}`, { id: FUNNEL_ID }, token)
  await detail(det.req, det.res)

  const port = callJson('GET', '/api/funnels/portfolio', {}, token)
  await portfolio(port.req, port.res)

  const { trainingPage } = await import('../api/funnels/render')
  const { brandKit } = await import('../lib/brandKit')
  const html = trainingPage(
    { subdomain: LIVE_SUBDOMAIN, training_page: { headline: 'Book here: [BOOK_A_CALL_LINK]' } },
    {
      brand: brandKit({} as any),
      head: '',
      logoUrl: null,
      headshotUrl: null,
      businessName: null,
      legal: {},
      cookieNotice: false,
    } as any,
    []
  )

  console.log('\n-- every producer answers, and they answer the same thing --')
  {
    eq('publish 200', pub.status(), 200)
    eq('detail 200', det.status(), 200)
    eq('portfolio 200', port.status(), 200)

    const fromPublish = pub.body()?.url
    const fromDetail = det.body()?.public_url
    const fromPortfolio = port.body()?.funnels?.[0]?.public_url

    ok('publish produced a URL', typeof fromPublish === 'string', String(fromPublish))
    // ACROSS PRODUCERS, NOT AGAINST A LITERAL. A shared literal in this file
    // would stay green while all three drifted together.
    eq('detail === publish', fromDetail, fromPublish)
    eq('portfolio === publish', fromPortfolio, fromPublish)

    // The public page emits a HOST, not a URL — so compare the host of the
    // composed URL against the label a lead actually reads.
    const host = new URL(String(fromPublish)).host
    ok(`the rendered page carries ${host}`, html.includes(host), html.slice(0, 300))
  }

  console.log('\n-- and it is the domain vercel.json actually routes --')
  {
    // EXTENDS the artifact comparison rather than adding a second check: the
    // same parse, now measured against the URL these endpoints serve instead of
    // against a constant. vercel.json is static JSON and cannot read
    // FUNNEL_PUBLIC_DOMAIN, so this equality is the requirement, not a formality.
    const vercelJson = fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')
    const routed = new Set<string>()
    for (const m of vercelJson.matchAll(/"type":\s*"host",\s*"value":\s*"([^"]+)"/g)) {
      routed.add(m[1].replace(/\\/g, '').replace(/^\(\[\^\.\]\+\)\./, '').replace(/^www\./, ''))
    }
    eq('vercel.json routes exactly one apex', [...routed], ['freeminiworkshop.com'])
    const apex = [...routed][0]
    const served = new URL(String(pub.body()?.url)).host
    ok('the served address sits under it', served.endsWith(`.${apex}`), `${served} is not under ${apex}`)
    eq('and funnel_domain IS it', det.body()?.funnel_domain, apex)
  }

  console.log('\n-- a funnel with no subdomain has no address --')
  {
    funnelRows = [DRAFT_ROW]
    singleFunnel = DRAFT_ROW

    const d = callJson('GET', `/api/funnels/${DRAFT_ID}`, { id: DRAFT_ID }, token)
    await detail(d.req, d.res)
    const p = callJson('GET', '/api/funnels/portfolio', {}, token)
    await portfolio(p.req, p.res)

    eq('detail public_url is null', d.body()?.public_url, null)
    eq('portfolio public_url is null', p.body()?.funnels?.[0]?.public_url, null)
    // NOT '' AND NOT THE BARE HOST — the two wrong answers that both look
    // falsy-ish at a glance. '' interpolates into href="" (a link to the current
    // page); the bare host sends a coach's own link to the shared hub.
    ok('not an empty string', d.body()?.public_url !== '', 'empty string renders as href=""')
    ok(
      'not the bare apex',
      d.body()?.public_url !== `https://${d.body()?.funnel_domain}`,
      'a draft would link to the hub, which is somebody else\'s page'
    )
    // The slug stays '' on purpose: a slug that has not been chosen is a
    // different fact from an address that does not exist.
    eq('slug is still the empty string', p.body()?.funnels?.[0]?.slug, '')
    // Still serves the preview host — this is the coach who needs it most.
    eq('and funnel_domain is still served', d.body()?.funnel_domain, 'freeminiworkshop.com')
  }

  console.log('\n-- the coach with NO funnels still gets the preview host --')
  {
    // The portfolio early-returns on zero funnels, and that branch is the one a
    // "add a field to the response" change forgets — while being the only branch
    // where a coach is typing their first subdomain and has nothing else to
    // preview from.
    funnelRows = []
    const p = callJson('GET', '/api/funnels/portfolio', {}, token)
    await portfolio(p.req, p.res)
    eq('zero-funnel branch answers', p.status(), 200)
    eq('with an empty list', p.body()?.funnels, [])
    eq('and funnel_domain', p.body()?.funnel_domain, 'freeminiworkshop.com')
  }

  console.log('\n-- PATCH hands back the new address, so a save cannot go stale --')
  {
    // subdomain is editable on this endpoint. A PATCH that returns the row
    // without its address forces the caller to recompose one, which is where the
    // frontend's literal came from in the first place.
    const src = fs.readFileSync(path.join(process.cwd(), 'api/funnels/[id]/index.ts'), 'utf8')
    const responses = [...src.matchAll(/res\.status\(200\)\.json\(([^\n]*)\)/g)].map((m) => m[1])
    ok('every 200 on this endpoint carries the address', responses.length > 0 && responses.every((r) => r.includes('addressFields')), responses.join(' | '))
  }

  console.log('\n-- no second composer --')
  {
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
    // Anything joining a subdomain to a host by hand, outside the owner.
    const composers = sources.filter(
      (f) =>
        f !== 'lib/funnelDomain.ts' &&
        /https:\/\/\$\{[^}]*\}\.\$\{[^}]*\}/.test(fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
    )
    eq('nothing joins a subdomain to a host by hand', composers, [])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
