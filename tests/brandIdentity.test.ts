process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

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

const COACH = 'coach-1'

// THE TWO URLS SHARE A BUCKET, and these fixtures are shaped like the real ones
// on purpose. Both live in `avatars`, and both carry the coach's id:
//
//   account photo   .../public/avatars/avatars/<uid>
//   brand headshot  .../public/avatars/brand/<uid>/headshot
//
// So the obvious phrasings of "the account photo did not leak" are all wrong,
// and wrong in the direction that looks like a passing guard until a coach
// actually uploads a headshot. Measured against the real production values:
//
//   no '/avatars/'            catches the leak, FALSE-FIRES on the headshot
//   no '<coach uid>'          catches the leak, FALSE-FIRES on the headshot
//   no '/storage/v1/object/'  catches the leak, FALSE-FIRES on the headshot
//   not '/avatars/avatars/<uid>'                    catches it, allows it
//
// Only the last one is a leak guard. The others are bucket-shaped, and the
// tempting fix when one of them fires on a legitimate value is to weaken it —
// which is how the guard quietly stops guarding. ASSERT THE ACCOUNT PHOTO'S
// SPECIFIC VALUE IS ABSENT, never the bucket, the id, or the storage host.
//
// Earlier fixtures here used cdn.example.com for the account photo and never
// built a brand URL at all, so the two could not collide and a bucket-shaped
// guard would have passed this suite. The fixtures now make that impossible:
// ACCEPTANCE 5 requires '/avatars/' to be PRESENT in a healthy page.
const STORAGE = 'https://stub.supabase.co/storage/v1/object/public'
const ACCOUNT_AVATAR = `${STORAGE}/avatars/avatars/${COACH}?v=1786022484350`
const BRAND_HEADSHOT = `${STORAGE}/avatars/brand/${COACH}/headshot?v=1786024979335`

// The account object's path, which appears in the account photo's URL and in
// nothing else. This is the string every leak assertion below tests for.
const ACCOUNT_OBJECT = `/avatars/avatars/${COACH}`

let settingsRow: any = {}
let uploadedObjects: Array<{ path: string; contentType: string }> = []
let settingsWrites: any[] = []
let userWrites: any[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/storage/v1/object/')) {
    const m = /\/object\/(?:avatars)\/(.+?)(?:\?|$)/.exec(url)
    uploadedObjects.push({ path: m ? m[1] : url, contentType: String(init?.headers?.['content-type'] || '') })
    return json({ Key: 'avatars/x' })
  }
  if (url.includes('/rest/v1/users')) {
    if (method === 'PATCH') {
      userWrites.push(body)
      return json([body])
    }
    // The account row ALWAYS carries an avatar. If a resolver can reach it, it
    // will; the assertions below prove none of them do.
    return json({ id: COACH, name: 'Alex Rivera', avatar_url: ACCOUNT_AVATAR, bio: 'Coach bio', profession: 'Coach', status: 'active', role: 'user' })
  }
  if (url.includes('/rest/v1/funnel_business_settings')) {
    if (method === 'POST' || method === 'PATCH') {
      settingsWrites.push(body)
      return json([body])
    }
    return json(settingsRow)
  }
  if (url.includes('/rest/v1/mtm_generations')) return json(null)
  return json({})
}) as typeof fetch

function makeRes() {
  const out: any = { status: 0, body: null, html: '' }
  const res: any = {
    setHeader() {},
    status(c: number) {
      out.status = c
      return res
    },
    json(v: unknown) {
      out.body = v
      return res
    },
    send(v: unknown) {
      out.html = String(v)
      return res
    },
    end() {
      return res
    },
  }
  return { res, out }
}

const FUNNEL = {
  id: 'funnel-1',
  user_id: COACH,
  subdomain: 'alex',
  status: 'live',
  headline: 'A headline',
  video_url: null,
  cookie_notice_enabled: false,
  landing_page: {},
  training_page: {},
  booking_page: {},
}

;(async () => {
  const { loadBranding, landingPage, trainingPage, bookPage } = await import('../api/funnels/render')

  console.log('\n-- ACCEPTANCE 1: a funnel page never contains the account avatar --')
  // Asserted against the RENDERED HTML by value, not by reading the resolver.
  // The fallback was firstUrl(settings.headshot_url, owner.avatar_url): a coach
  // who had never opened Brand Identity had their account profile picture
  // published on their funnel, with nothing telling them.
  {
    settingsRow = { user_id: COACH, headshot_url: null, logo_url: null, business_name: 'Rivera Coaching' }
    const b = await loadBranding(FUNNEL)

    ok('no headshot is resolved at all', b.headshotUrl === null, JSON.stringify(b.headshotUrl))

    const pages: Array<[string, string]> = [
      ['landing', landingPage(FUNNEL, b)],
      ['training', trainingPage(FUNNEL, b, [])],
      ['book', bookPage(FUNNEL, b)],
    ]
    for (const [name, html] of pages) {
      ok(`${name} page renders`, html.length > 0)
      ok(
        `${name} page does not contain the account avatar`,
        !html.includes(ACCOUNT_OBJECT),
        'the account profile picture reached a public funnel page'
      )
      // A SECOND, WEAKER CHECK, labelled as such. It catches a template that
      // emitted the column NAME; it is blind to a leaked VALUE, because no
      // storage URL contains the string 'avatar_url'. The line above is the
      // leak guard. Keeping them separate so neither is mistaken for the other.
      ok(`${name} page does not name the avatar_url column`, !html.includes('avatar_url'))
    }
  }

  console.log('\n-- ACCEPTANCE 2: a coach WITH a Brand Identity headshot is unchanged --')
  {
    settingsRow = { user_id: COACH, headshot_url: BRAND_HEADSHOT, logo_url: null, business_name: 'Rivera Coaching' }
    const b = await loadBranding(FUNNEL)
    ok('the brand headshot resolves', b.headshotUrl === BRAND_HEADSHOT, JSON.stringify(b.headshotUrl))

    // The headshot renders on the BOOK page (classicBookPage), not the landing
    // page — checked rather than assumed, after the first version of this
    // assertion looked for it on the wrong surface and "failed" against
    // correct code.
    const html = bookPage(FUNNEL, b)
    ok('and it reaches the rendered page', html.includes(BRAND_HEADSHOT), 'the configured headshot did not render')
    ok('still no account avatar', !html.includes(ACCOUNT_OBJECT))

    // Nothing else regressed: the landing and training pages render as before.
    ok('landing still renders', landingPage(FUNNEL, b).length > 0)
    ok('training still renders', trainingPage(FUNNEL, b, []).length > 0)
  }

  console.log('\n-- ACCEPTANCE 5: the leak guard is VALUE-shaped, not bucket-shaped --')
  // The assertion above is only worth anything if it can tell the two apart.
  // This block proves it can, by requiring the healthy page to contain exactly
  // the substrings a lazier guard would have banned. Rewrite the guard as
  // "no /avatars/", "no <uid>", or "no /storage/v1/object/" and this fails —
  // which is the point: the suite should refuse the degraded phrasing rather
  // than quietly accept it.
  {
    settingsRow = { user_id: COACH, headshot_url: BRAND_HEADSHOT, logo_url: null, business_name: 'Rivera Coaching' }
    const html = bookPage(FUNNEL, await loadBranding(FUNNEL))

    ok('a healthy page DOES contain the shared bucket', html.includes('/avatars/'), 'fixtures no longer share a bucket — the collision this pins is gone')
    ok('a healthy page DOES contain the coach id', html.includes(COACH))
    ok('a healthy page DOES contain the storage host', html.includes('/storage/v1/object/'))
    ok('and still does NOT contain the account object', !html.includes(ACCOUNT_OBJECT))

    // Stated as the predicate itself, so the distinction is executable rather
    // than something a reader has to reconstruct from the fixtures.
    const leaked = (s: string) => s.includes(ACCOUNT_OBJECT)
    ok('the guard catches the account photo', leaked(ACCOUNT_AVATAR))
    ok('the guard allows the brand headshot', !leaked(BRAND_HEADSHOT))
  }

  console.log('\n-- ACCEPTANCE 3+4: the SECOND instance, found by sweeping --')
  // api/ai-coach/profile.ts had the identical firstUrl(headshot, avatar_url),
  // and its comment cited render.ts as the justification: "the SAME resolution
  // the public funnel pages already use". The defect propagated BECAUSE it was
  // consistent. Fixing only render.ts would have left this live and made that
  // comment stale in the same move.
  {
    const { readFileSync, readdirSync } = await import('fs')
    const { join } = await import('path')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
      )

    // A fallback INTO the account record, in any file. avatarUrlForSeed builds
    // generated persona images and has nothing to do with a user's own photo, so
    // it is not matched here.
    const offenders: string[] = []
    for (const dir of ['api', 'lib']) {
      for (const file of walk(join(process.cwd(), dir))) {
        const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
        if (/firstUrl\([^)]*avatar_url/.test(src) || /headshot_url\s*\|\|\s*[\w.]*avatar_url/.test(src)) {
          offenders.push(file.split(process.cwd() + '/')[1])
        }
      }
    }
    ok(
      'no surface falls back from headshot_url to the account avatar',
      offenders.length === 0,
      offenders.join(', ') + ' — a fallback reaching into a different record is a decision about someone data, not a default'
    )

    // And the AI Coach profile specifically, since that is the one the sweep found.
    const profile: Handler = (await import('../api/ai-coach/profile')).default
    const src = readFileSync(join(process.cwd(), 'api/ai-coach/profile.ts'), 'utf8')
    ok('ai-coach/profile does not select avatar_url', !/select\('[^']*avatar_url/.test(src), 'still selecting a column it must not publish')
    void profile
  }

  console.log('\n-- ACCEPTANCE 6: brand upload writes the BRAND fields, never the account avatar --')
  {
    const upload: Handler = (await import('../api/brand/upload-image')).default
    const { Readable } = await import('stream')

    async function send(field: string, contentType = 'image/png', bytes = 2048) {
      uploadedObjects = []
      settingsWrites = []
      userWrites = []
      const req: any = Readable.from([Buffer.alloc(bytes, 1)])
      req.method = 'POST'
      req.headers = { 'content-type': contentType, authorization: `Bearer ${await createSessionToken(COACH)}` }
      req.query = { field }
      const r = makeRes()
      await upload(req, r.res)
      return r.out
    }

    const logo = await send('logo')
    ok('a logo upload succeeds', logo.status === 200, `${logo.status} ${JSON.stringify(logo.body)}`)
    ok('and writes logo_url', settingsWrites.some((w) => w && 'logo_url' in w), JSON.stringify(settingsWrites))
    ok('never users.avatar_url', userWrites.length === 0, JSON.stringify(userWrites))

    const headshot = await send('headshot')
    ok('a headshot upload writes headshot_url', settingsWrites.some((w) => w && 'headshot_url' in w), JSON.stringify(settingsWrites))
    ok('and still never touches the account row', userWrites.length === 0, JSON.stringify(userWrites))
    ok('the object path is scoped to the coach', uploadedObjects[0]?.path.startsWith(`brand/${COACH}/`), JSON.stringify(uploadedObjects))
    ok('the response returns the url for the form to show', typeof headshot.body?.url === 'string' && headshot.body.url.includes('?v='), JSON.stringify(headshot.body))

    // A query param that reaches a column name is a column name the caller chose.
    const bogus = await send('avatar')
    ok("a field of 'avatar' is refused", bogus.status === 400, `${bogus.status} ${JSON.stringify(bogus.body)}`)
    ok('and wrote nothing anywhere', settingsWrites.length === 0 && userWrites.length === 0)

    const badType = await send('logo', 'image/gif')
    ok('an unsupported type is 415', badType.status === 415, `${badType.status}`)

    const tooBig = await send('logo', 'image/png', 5 * 1024 * 1024)
    ok('an oversized image is refused with the shared status', tooBig.status === 413, `${tooBig.status} ${JSON.stringify(tooBig.body)}`)
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
