// ONE VARIABLE, BOTH READERS — proved by moving it, not by reading the imports.
//
// A separate file from tests/funnelDomain.test.ts because FUNNEL_PUBLIC_DOMAIN is
// captured at module load: one process can hold the default or an override, never
// both. The runner gives each test file its own process for exactly this reason.
//
// The value here is deliberately nothing like either real domain. If a reader had
// kept its own `?? 'freeminiworkshop.com'` fallback, or had been quietly restored
// to a literal, its output would still read freeminiworkshop.com and this file
// would go red — which is the only way to tell a wired-up reader from one that
// merely looks wired up.
//
// WHAT THIS DOES NOT PROVE, and must not be read as proving: that changing the
// variable relocates the funnels. It does not. Requests land where DNS and
// vercel.json's static host rules send them, and vercel.json cannot read an
// environment variable. Moving this variable moves only the addresses we
// ADVERTISE. Keeping it equal to what vercel.json routes is the actual
// requirement, and tests/funnelDomain.test.ts is where those two artifacts are
// compared.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.FUNNEL_PUBLIC_DOMAIN = 'moved.example'

import { projectSelect } from './support/postgrest'

const SUB = 'charge-demo'
const MOVED_URL = 'https://charge-demo.moved.example'
const MOVED_HOST = 'charge-demo.moved.example'

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

const FUNNEL_ROW = {
  id: FUNNEL_ID,
  user_id: USER_ID,
  subdomain: SUB,
  status: 'live',
  published_at: '2026-07-01T00:00:00.000Z',
  landing_page: {
    headline: 'A free training',
    subheadline: 'Thirty minutes, no pitch',
    problem_bullets: ['One', 'Two', 'Three'],
    solution_bullets: ['Four', 'Five', 'Six'],
    cta_label: 'Watch it',
  },
}

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
    // See tests/funnelDomain.test.ts — null keeps generateFunnelCovers from
    // launching Chromium; publish catches it, as it is designed to.
    if (url.includes('generation_id')) return json(null)
    return json(FUNNEL_ROW)
  }
  return json([])
}) as typeof fetch

;(async () => {
  const { createSessionToken } = await import('../lib/auth')
  const token = await createSessionToken(USER_ID)

  console.log('\n-- publish follows the variable --')
  {
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
    const { default: publish } = await import('../api/funnels/[id]/publish')
    await publish(req, res)

    eq('publish succeeds', status, 200)
    eq('and its URL moved with the variable', body?.url, MOVED_URL)
  }

  console.log('\n-- the page a lead reads follows the same variable --')
  {
    const { trainingPage } = await import('../api/funnels/render')
    const { brandKit } = await import('../lib/brandKit')
    const html = trainingPage(
      { subdomain: SUB, training_page: { headline: 'Book here: [BOOK_A_CALL_LINK]' } },
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
    ok('the rendered host label moved too', html.includes(MOVED_HOST), html.slice(0, 400))
    ok(
      'and no reader kept its own fallback',
      !html.includes('freeminiworkshop.com'),
      'a reader is still building hosts from a literal of its own'
    )
  }

  console.log('\n-- and every other writer of a public funnel URL moved with them --')
  {
    // The two above are the readers the acceptance named. These are the rest of
    // the eight sites that used to declare the domain themselves, driven rather
    // than inspected, so a reader left behind on a literal shows up here instead
    // of surviving until a coach sends the link.
    const { funnelUrls } = await import('../lib/funnelLaunchAssets')
    eq('funnelUrls (launch assets)', funnelUrls(SUB).base, MOVED_URL)

    const { buildBookingManageUrl } = await import('../lib/bookingManage')
    ok(
      'buildBookingManageUrl (lead-facing booking link)',
      buildBookingManageUrl('33333333-3333-4333-8333-333333333333', SUB).startsWith(`${MOVED_URL}/api/funnel/booking`),
      buildBookingManageUrl('33333333-3333-4333-8333-333333333333', SUB)
    )
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
