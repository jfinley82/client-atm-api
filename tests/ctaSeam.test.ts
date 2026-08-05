process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'
process.env.FUNNEL_PUBLIC_DOMAIN = 'freeminiworkshop.com'

// Dynamic imports below: the handlers reach lib/email.ts, which constructs
// `new Resend(process.env.RESEND_API_KEY!)` at module scope.
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const USER = 'user-1'
const CARD = 'card-1'
const GEN_ID = 'gen-1'

// The exact body shape that produced the live bug: a warm invite ending on a
// standalone [REGISTER_LINK], which rendered as an inline "register" anchor AND
// a pill button underneath.
const WARM_BODY = 'You asked me about this last week.\n\nIt takes twenty minutes.\n\n[REGISTER_LINK]'

let users: Record<string, any> = {}
let funnels: any[] = []
let generations: any[] = []
let writes: { url: string; body: any }[] = []

function reset() {
  users = { [USER]: { name: 'Coach', email: 'c@example.com', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} } }
  funnels = [{ user_id: USER, subdomain: 'coachco' }]
  generations = [{
    id: GEN_ID, user_id: USER, card_id: CARD, guide_url: 'https://cdn.example/guide.pdf',
    created_at: '2026-08-01T00:00:00Z',
    emails: [], book_a_call_emails: [],
    warm_invite_emails: [{ email_number: 1, send_timing: 'day 1', subject: 'Come along', body: WARM_BODY }],
  }]
  writes = []
}

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (method === 'PATCH' || method === 'POST' || method === 'PUT') writes.push({ url, body })

  if (url.includes('/rest/v1/users')) {
    const id = eqParam(url, 'id')
    return json(id && users[id] ? { id, ...users[id] } : null)
  }
  if (url.includes('/rest/v1/funnels')) {
    const uid = eqParam(url, 'user_id')
    return json(funnels.filter((f) => !uid || f.user_id === uid))
  }
  if (url.includes('/rest/v1/saved_outputs')) return json(null)
  if (url.includes('/rest/v1/mtm_generations')) {
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const row = generations.find((g) => g.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    const id = eqParam(url, 'id')
    const cardId = eqParam(url, 'card_id')
    let rows = generations.slice()
    if (id) rows = rows.filter((g) => g.id === id)
    if (cardId) rows = rows.filter((g) => g.card_id === cardId)
    if (/guide_url/.test(url)) {
      const withGuide = rows.filter((g) => g.guide_url)
      if (/limit=1/.test(url)) return json(withGuide.slice(0, 1))
    }
    if (/limit=1/.test(url)) return json(rows.slice(0, 1))
    return json(rows.length === 1 ? rows[0] : rows)
  }
  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { method?: string; query?: any; body?: any } = {}) {
  const token = await createSessionToken(USER)
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  await handler({ headers: { authorization: `Bearer ${token}` }, method: opts.method || 'GET', body: opts.body, query: opts.query || {} } as any, res)
  return { status, body: resBody }
}

const LINKS = {
  book: 'https://coachco.freeminiworkshop.com/?page=book',
  training: 'https://coachco.freeminiworkshop.com/?page=training',
  register: 'https://coachco.freeminiworkshop.com/',
  guide: 'https://cdn.example/guide.pdf',
}

// A rendered CTA button, as distinct from a plain inline anchor: it is the one
// carrying the button style.
const buttons = (html: string) => (html.match(/<a[^>]*background-color:[^>]*>/g) || [])
const anchors = (html: string) => (html.match(/<a [^>]*>/g) || [])

;(async () => {
  const email = await import('../lib/email')
  const generateHandler: Handler = (await import('../api/generate/index')).default

  console.log('\n-- the bug: one token must not render twice --')
  {
    const { bodyHtml, cta } = email.composeEmailBody(WARM_BODY, LINKS)
    ok('exactly one button', buttons(bodyHtml).length === 1, bodyHtml)
    ok('and exactly one anchor in total — no duplicate inline link', anchors(bodyHtml).length === 1, bodyHtml)
    ok('the button points at the register url', bodyHtml.includes(`href="${LINKS.register}"`), bodyHtml)
    ok('no lowercase inline "register" anchor text survives', !/>register</.test(bodyHtml), bodyHtml)
    ok('the raw token is gone from the html', !bodyHtml.includes('[REGISTER_LINK]'))
    ok('cta is still returned as metadata', cta?.label === 'Register' && cta?.url === LINKS.register, JSON.stringify(cta))
  }

  console.log('\n-- token alone on its line: block-level button, in that position --')
  {
    const { bodyHtml } = email.composeEmailBody(WARM_BODY, LINKS)
    ok('one button', buttons(bodyHtml).length === 1)
    ok('it carries the standalone spacing', /margin:20px 0 6px/.test(bodyHtml), buttons(bodyHtml)[0])
    // Position: the button follows the second paragraph's text, not the first.
    ok('it renders after the body copy, where the token sat', bodyHtml.indexOf('twenty minutes') < bodyHtml.indexOf('<a '), bodyHtml)
  }

  console.log('\n-- token mid-sentence: inline button, sentence intact, no separate anchor --')
  {
    const inlineBody = 'You can [REGISTER_LINK] any time before Friday.'
    const { bodyHtml } = email.composeEmailBody(inlineBody, LINKS)
    ok('one button', buttons(bodyHtml).length === 1, bodyHtml)
    ok('no second anchor for the same token', anchors(bodyHtml).length === 1, bodyHtml)
    ok('it carries the inline spacing, not the block spacing', /margin:0 2px/.test(bodyHtml), buttons(bodyHtml)[0])
    ok('the words before it survive', bodyHtml.includes('You can'), bodyHtml)
    ok('and the words after it survive — the sentence is not cut', bodyHtml.includes('any time before Friday.'), bodyHtml)
  }

  console.log('\n-- two button-eligible tokens: first is the button, second stays an anchor --')
  {
    const two = 'Watch it here: [TRAINING_LINK]\n\nOr if you are ready, [BOOK_A_CALL_LINK] instead.'
    const { bodyHtml, cta } = email.composeEmailBody(two, LINKS)
    ok('exactly one button', buttons(bodyHtml).length === 1, bodyHtml)
    ok('two anchors in total — button plus one inline', anchors(bodyHtml).length === 2, bodyHtml)
    ok('the button is the FIRST in reading order (training)', buttons(bodyHtml)[0].includes(LINKS.training), buttons(bodyHtml)[0])
    ok('the second renders as the lowercase inline anchor', bodyHtml.includes('>book a call<'), bodyHtml)
    ok('cta reports the primary', cta?.url === LINKS.training, JSON.stringify(cta))
  }
  {
    // A later occurrence of the SAME token is an inline anchor, not a 2nd button.
    const repeat = '[REGISTER_LINK]\n\nStill undecided? You can [REGISTER_LINK] later.'
    const { bodyHtml } = email.composeEmailBody(repeat, LINKS)
    ok('a repeated primary token yields only one button', buttons(bodyHtml).length === 1, bodyHtml)
    ok('the repeat renders as an inline anchor', bodyHtml.includes('>register<'), bodyHtml)
  }

  console.log('\n-- [GUIDE_LINK] is never a button --')
  {
    const withGuide = 'Grab [GUIDE_LINK] while you are here.\n\n[REGISTER_LINK]'
    const { bodyHtml, cta } = email.composeEmailBody(withGuide, LINKS)
    ok('one button only', buttons(bodyHtml).length === 1, bodyHtml)
    ok('and it is NOT the guide', !buttons(bodyHtml)[0].includes(LINKS.guide), buttons(bodyHtml)[0])
    ok('the guide renders as an inline anchor', bodyHtml.includes('>download the guide<'), bodyHtml)
    ok('cta is the register link', cta?.url === LINKS.register, JSON.stringify(cta))
  }
  {
    // Guide alone: no button at all, because it is not button-eligible.
    const guideOnly = 'Here is [GUIDE_LINK].'
    const { bodyHtml, cta } = email.composeEmailBody(guideOnly, LINKS)
    ok('a guide-only body has no button', buttons(bodyHtml).length === 0, bodyHtml)
    ok('and cta is null', cta === null, JSON.stringify(cta))
    ok('but the guide link still renders', bodyHtml.includes('>download the guide<'), bodyHtml)
  }

  console.log('-- and the comment saying so is still on BUTTON_ELIGIBLE --')
  {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/email.ts'), 'utf8')
    const decl = src.slice(Math.max(0, src.indexOf('const BUTTON_ELIGIBLE') - 500), src.indexOf('const BUTTON_ELIGIBLE'))
    ok('GUIDE_LINK exclusion is documented where it is decided', /GUIDE_LINK.*never a button/is.test(decl), decl.slice(-200))
  }

  console.log('\n-- a missing or invalid link degrades to text, with no button --')
  {
    const noRegister = email.composeEmailBody(WARM_BODY, { ...LINKS, register: undefined })
    ok('no button', buttons(noRegister.bodyHtml).length === 0, noRegister.bodyHtml)
    ok('cta is null', noRegister.cta === null, JSON.stringify(noRegister.cta))
    ok('the fallback words render, not the raw token', noRegister.bodyHtml.includes('register') && !noRegister.bodyHtml.includes('[REGISTER_LINK]'), noRegister.bodyHtml)

    const badUrl = email.composeEmailBody(WARM_BODY, { ...LINKS, register: 'javascript:alert(1)' })
    ok('an invalid url is refused a button', buttons(badUrl.bodyHtml).length === 0, badUrl.bodyHtml)
    ok('and cta stays null', badUrl.cta === null, JSON.stringify(badUrl.cta))
    ok('and the bad url never reaches the html', !badUrl.bodyHtml.includes('javascript:'), badUrl.bodyHtml)
  }

  console.log('\n-- the button is brand-coloured, and its markup survives an email client --')
  {
    const { bodyHtml } = email.composeEmailBody(WARM_BODY, LINKS, '#123456')
    ok('the coach brand colour is used', bodyHtml.includes('background-color:#123456'), buttons(bodyHtml)[0])
    ok('no class attribute', !/class\s*=/.test(bodyHtml), bodyHtml)
    ok('no table wrapper', !/<table/i.test(bodyHtml), bodyHtml)
    ok('the label carries the button-only arrow', bodyHtml.includes('Register &rarr;'), buttons(bodyHtml)[0])
    const dflt = email.composeEmailBody(WARM_BODY, LINKS)
    ok('and it defaults rather than rendering colourless', /background-color:#[0-9A-Fa-f]{3,8}/.test(dflt.bodyHtml), buttons(dflt.bodyHtml)[0])
  }

  console.log('\n-- STORAGE IS UNTOUCHED: asserted on the column, not the return value --')
  {
    reset()
    const before = JSON.stringify(generations[0].warm_invite_emails)
    const res = await call(generateHandler, { query: { card_id: CARD } })
    const after = JSON.stringify(generations[0].warm_invite_emails)

    ok('the read succeeded', res.status === 200, `${res.status}`)
    ok('the stored column is byte-identical after rendering', after === before, `before ${before}\n      after  ${after}`)
    ok('the stored body still holds the RAW token', generations[0].warm_invite_emails[0].body === WARM_BODY, JSON.stringify(generations[0].warm_invite_emails[0].body))
    ok('no HTML was written into storage', !/[<>]/.test(generations[0].warm_invite_emails[0].body))
    ok('the read path issued no writes at all', writes.length === 0, JSON.stringify(writes.map((w) => w.url)))

    // And the rendered payload really did carry the button, so the assertion
    // above is not passing simply because nothing rendered.
    const rendered = res.body?.warm_invite_emails?.[0]
    ok('the response carried a rendered body_html', typeof rendered?.body_html === 'string' && rendered.body_html.length > 0, JSON.stringify(rendered)?.slice(0, 200))
    ok('with exactly one button in it', buttons(rendered?.body_html || '').length === 1, rendered?.body_html)
    ok('and body is returned unchanged alongside it', rendered?.body === WARM_BODY, JSON.stringify(rendered?.body))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
