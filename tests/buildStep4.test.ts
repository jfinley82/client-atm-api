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

let users: Record<string, any> = {}
let funnels: any[] = []
let generations: any[] = []

function mkExercise(prompt: string, recommended: boolean, extra: any = {}) {
  return { prompt, lines: 4, recommended, collects: `collects ${prompt}`, why_fits: `fits ${prompt}`, ...extra }
}

function mkWorkbook() {
  return {
    title: 'WB',
    sections: [
      { sectionTitle: 'S1', keyInsight: 'k', reflection: 'r', exercises: [mkExercise('A', true), mkExercise('B', false), mkExercise('C', false)] },
      { sectionTitle: 'S2', keyInsight: 'k', reflection: 'r', exercises: [mkExercise('D', true), mkExercise('E', false)] },
    ],
  }
}

function reset() {
  users = { [USER]: { name: 'Coach', email: 'c@example.com', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} } }
  funnels = [{ user_id: USER, subdomain: 'coachco' }]
  generations = [{
    id: GEN_ID, user_id: USER, card_id: CARD, guide_url: 'https://cdn.example/guide.pdf',
    created_at: '2026-08-01T00:00:00Z', workbook: mkWorkbook(),
    emails: [], warm_invite_emails: [], book_a_call_emails: [],
  }]
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
    // guide_url lookup (not.is.null + order + limit 1)
    if (/guide_url=not\.is\.null/.test(url) || /guide_url/.test(url)) {
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

;(async () => {
  const email = await import('../lib/email')
  const mtg = await import('../lib/microTrainingGenerator')
  const exercisesHandler: Handler = (await import('../api/generate/exercises')).default

  const LINKS = { book: 'https://coachco.freeminiworkshop.com/?page=book', training: 'https://coachco.freeminiworkshop.com/?page=training', register: 'https://coachco.freeminiworkshop.com/', guide: 'https://cdn.example/guide.pdf' }

  console.log('\n-- ITEM 1: read path composes identically to the send path --')
  // A standalone primary token: composeEmailBody strips it from the body and
  // surfaces it as the button.
  const standalone = 'First para.\n\nSecond para.\n\n[BOOK_A_CALL_LINK]'
  const sendSide = email.composeEmailBody(standalone, LINKS)
  ok('standalone primary token becomes the cta', sendSide.cta?.label === 'Book your call' && sendSide.cta?.url === LINKS.book, JSON.stringify(sendSide.cta))
  ok('and is stripped from the body html', !sendSide.bodyHtml.includes('[BOOK_A_CALL_LINK]'))
  ok('paragraphs survive as separate blocks', (sendSide.bodyHtml.match(/<p/g) || []).length >= 2, sendSide.bodyHtml.slice(0, 160))

  console.log('\n-- a BULLETED body: the case a paragraphs:string[] shape would flatten --')
  const bulleted = 'Here is why:\n\n- first point\n- second point\n- third point\n\nThat is the shape.\n\n[TRAINING_LINK]'
  const bulletComposed = email.composeEmailBody(bulleted, LINKS)
  ok('runs of "- " lines become a real <ul>', bulletComposed.bodyHtml.includes('<ul'), bulletComposed.bodyHtml.slice(0, 200))
  ok('each bullet is its own <li>', (bulletComposed.bodyHtml.match(/<li/g) || []).length === 3)
  ok('cta resolves to the training button', bulletComposed.cta?.label === 'Watch the training' && bulletComposed.cta?.url === LINKS.training)

  console.log('\n-- an INLINE primary token stays in the sentence (never strips mid-copy) --')
  const inline = 'Grab your spot here [BOOK_A_CALL_LINK] before Friday.\n\nSee you then.'
  const inlineComposed = email.composeEmailBody(inline, LINKS)
  ok('cta is still surfaced', inlineComposed.cta?.url === LINKS.book)
  ok('the sentence is NOT broken — surrounding words survive', inlineComposed.bodyHtml.includes('before Friday'), inlineComposed.bodyHtml.slice(0, 200))
  ok('the token itself is replaced by a link, not left literal', !inlineComposed.bodyHtml.includes('[BOOK_A_CALL_LINK]'))

  console.log('\n-- [GUIDE_LINK] is never a button, only ever inline --')
  const guideOnly = 'Download it here: [GUIDE_LINK]\n\nEnjoy.'
  const guideComposed = email.composeEmailBody(guideOnly, LINKS)
  ok('no cta from a guide-only body', guideComposed.cta === null, JSON.stringify(guideComposed.cta))
  ok('but the guide url is linked inline', guideComposed.bodyHtml.includes('cdn.example/guide.pdf'))

  console.log('\n-- ITEM 1: preview links resolve like a real send --')
  reset()
  const withFunnel = await email.resolvePreviewEmailLinks(USER)
  ok('uses the coach subdomain when one exists', withFunnel.links.book === LINKS.book, withFunnel.links.book)
  ok('reports has_funnel', withFunnel.resolved.has_funnel === true)
  ok('resolves the published guide url', withFunnel.links.guide === 'https://cdn.example/guide.pdf')
  ok('reports guide_published', withFunnel.resolved.guide_published === true)

  console.log('\n-- NO funnel yet: the preview must still show a button, not under-report --')
  reset()
  funnels = []
  const noFunnel = await email.resolvePreviewEmailLinks(USER)
  ok('falls back to the bare public domain', noFunnel.links.book === 'https://freeminiworkshop.com/?page=book', noFunnel.links.book)
  ok('has_funnel false so the caller can say so', noFunnel.resolved.has_funnel === false)
  const noFunnelComposed = email.composeEmailBody(standalone, noFunnel.links)
  ok('cta STILL resolves (the whole point of the fallback base)', noFunnelComposed.cta !== null, JSON.stringify(noFunnelComposed.cta))

  console.log('\n-- no published guide: [GUIDE_LINK] degrades, nothing crashes --')
  reset()
  generations[0].guide_url = null
  const noGuide = await email.resolvePreviewEmailLinks(USER)
  ok('guide undefined', noGuide.links.guide === undefined)
  ok('guide_published false', noGuide.resolved.guide_published === false)
  const degraded = email.composeEmailBody('See [GUIDE_LINK] for more.', noGuide.links)
  ok('body still renders', degraded.bodyHtml.length > 0)

  console.log('\n-- ITEM 2: selectedExercises falls back to recommended when untouched --')
  const untouched = [mkExercise('A', true), mkExercise('B', false), mkExercise('C', false)]
  const fellBack = mtg.selectedExercises(untouched)
  ok('exactly the recommended one', fellBack.length === 1 && fellBack[0].prompt === 'A', JSON.stringify(fellBack.map((e: any) => e.prompt)))

  console.log('\n-- honours the coach choice once selected exists --')
  const chosen = [mkExercise('A', true, { selected: false }), mkExercise('B', false, { selected: true }), mkExercise('C', false, { selected: true })]
  const coachPicked = mtg.selectedExercises(chosen)
  ok('AI default dropped, coach picks used', coachPicked.map((e: any) => e.prompt).join(',') === 'B,C')
  ok('recommended is NOT consulted once a choice exists', !coachPicked.some((e: any) => e.prompt === 'A'))

  console.log('\n-- a coach who deselects everything gets nothing, not the AI default --')
  const none = [mkExercise('A', true, { selected: false }), mkExercise('B', false, { selected: false })]
  ok('empty, not a silent fallback', mtg.selectedExercises(none).length === 0)

  console.log('\n-- the cap holds even against hand-edited data --')
  const overfull = [mkExercise('A', true, { selected: true }), mkExercise('B', true, { selected: true }), mkExercise('C', true, { selected: true })]
  ok('capped at 2', mtg.selectedExercises(overfull).length === mtg.MAX_SELECTED_EXERCISES_PER_SECTION)
  const overRecommended = [mkExercise('A', true), mkExercise('B', true), mkExercise('C', true)]
  ok('capped on the recommended fallback path too', mtg.selectedExercises(overRecommended).length === 2)

  console.log('\n-- ITEM 2: the save endpoint --')
  reset()
  const saveTwo = await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: [{ index: 0, selected: [0, 1] }] } })
  ok('accepts a SECOND selection', saveTwo.status === 200, JSON.stringify(saveTwo.body))
  const sec0 = generations[0].workbook.sections[0].exercises
  ok('writes selected flags', sec0[0].selected === true && sec0[1].selected === true && sec0[2].selected === false)
  ok('leaves the AI recommended untouched', sec0[0].recommended === true && sec0[1].recommended === false)
  ok('echoes the saved selection', JSON.stringify(saveTwo.body?.sections?.[0]?.selected) === '[0,1]')

  reset()
  const saveThree = await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: [{ index: 0, selected: [0, 1, 2] }] } })
  ok('REJECTS a third selection', saveThree.status === 400 && saveThree.body?.error === 'too_many_selected', JSON.stringify(saveThree.body))
  ok('and wrote nothing', generations[0].workbook.sections[0].exercises.every((e: any) => e.selected === undefined))

  reset()
  const unknownSection = await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: [{ index: 9, selected: [0] }] } })
  ok('unknown section index 400s', unknownSection.status === 400 && unknownSection.body?.error === 'unknown_section')
  const unknownExercise = await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: [{ index: 0, selected: [7] }] } })
  ok('out-of-range exercise index 400s', unknownExercise.status === 400 && unknownExercise.body?.error === 'unknown_exercise')
  ok('nothing partially applied', generations[0].workbook.sections[0].exercises.every((e: any) => e.selected === undefined))

  reset()
  const otherSectionUntouched = await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: [{ index: 0, selected: [1] }] } })
  ok('200', otherSectionUntouched.status === 200)
  ok('an unmentioned section keeps NO selected flags (still AI default)', generations[0].workbook.sections[1].exercises.every((e: any) => e.selected === undefined))

  reset()
  ok('no card_id 400s', (await call(exercisesHandler, { method: 'PATCH', query: {}, body: { sections: [] } })).status === 400)
  ok('non-array sections 400s', (await call(exercisesHandler, { method: 'PATCH', query: { card_id: CARD }, body: { sections: 'nope' } })).status === 400)
  const wrongCard = await call(exercisesHandler, { method: 'PATCH', query: { card_id: 'not-mine' }, body: { sections: [{ index: 0, selected: [0] }] } })
  ok('another card 404s', wrongCard.status === 404)
  ok('GET 405s', (await call(exercisesHandler, { method: 'GET', query: { card_id: CARD } })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
