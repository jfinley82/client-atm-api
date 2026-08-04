process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub'

// Dynamic imports: both endpoints reach lib/aiCoach.ts, which constructs
// `new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY!})` at module scope.
import { signCoachToken, signWatchToken, signOfferToken } from '../lib/funnelLeadToken'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const COACH = 'coach-1'
const OTHER = 'coach-2'
const FUNNEL = 'funnel-1'
const LEAD = 'lead-1'
const GEN = 'gen-1'
const CARD_FUNNEL = 'card-funnel'
const CARD_PRIMARY = 'card-primary'
const CARD_OTHER_OWNED = 'card-other-owned' // the coach's, but NOT in the bot's card_ids

let leads: any[] = []
let funnels: any[] = []
let users: Record<string, any> = {}
let generations: any[] = []
let cards: any[] = []
let savedOutputs: any[] = []
let businessSettings: any = null

function eqParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? m[1] : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/funnel_leads')) return json(leads.find((l) => l.id === eqParam(url, 'id')) ?? null)
  if (url.includes('/rest/v1/funnels')) return json(funnels.find((f) => f.id === eqParam(url, 'id')) ?? null)
  if (url.includes('/rest/v1/users')) return json(users[eqParam(url, 'id') || ''] ?? null)
  if (url.includes('/rest/v1/mtm_generations')) return json(generations.find((g) => g.id === eqParam(url, 'id')) ?? null)
  if (url.includes('/rest/v1/problem_solution_cards')) {
    const id = eqParam(url, 'id'); const uid = eqParam(url, 'user_id')
    return json(cards.find((c) => c.id === id && (!uid || c.user_id === uid)) ?? null)
  }
  if (url.includes('/rest/v1/funnel_business_settings')) return json(businessSettings)
  if (url.includes('/rest/v1/saved_outputs')) {
    const uid = eqParam(url, 'user_id'); const tt = eqParam(url, 'tool_type')
    return json(savedOutputs.find((s) => s.user_id === uid && s.tool_type === tt) ?? null)
  }
  return json([])
}) as typeof fetch

async function call(handler: Handler, token: string, mode: 'bearer' | 'query' | 'header' = 'bearer', query: any = {}) {
  let status = 0, body: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { body = v; return res }, end() { return res } }
  const req: any = { method: 'GET', headers: {}, query: { ...query } }
  if (mode === 'bearer') req.headers.authorization = `Bearer ${token}`
  if (mode === 'header') req.headers['x-coach-token'] = token
  if (mode === 'query') req.query.t = token
  await handler(req, res)
  return { status, body }
}

const SYNOPSIS = {
  audience_quote: "I freeze when it's time to say the number.",
  cost_of_inaction: 'Every month undercharging compounds the resentment.',
  objection_dissolved: '"I don\'t want to seem greedy" reframed as fair exchange.',
  teaching_outline: [{ point: 'Name the fear', detail: 'Where the cringe comes from' }],
  solution_summary: 'A tight synopsis of the solution.',
  training_title: 'Charge Without the Cringe',
  // per-card before/after — the real transformation source
  transformation: { before: 'Pitches from guilt.', after: 'Runs calls that diagnose fit.' },
  // extra keys that must NOT leak into the response
  high_ticket_pitch: 'SHOULD NOT APPEAR',
  offer_includes: ['SHOULD NOT APPEAR'],
  framework_fit: 'SHOULD NOT APPEAR',
}

// A SECOND card with a DIFFERENT before/after, to prove the panel follows the
// resolved card rather than being account-level.
const SYNOPSIS_PRIMARY = {
  ...SYNOPSIS,
  training_title: 'Primary Training',
  transformation: { before: 'PRIMARY before.', after: 'PRIMARY after.' },
}

const TRANSFORMATION = {
  before_state: 'Stuck undercharging.',
  after_state: 'Charging full price.',
  before_results: 'Booked but broke.',
  after_results: 'Fewer clients, more revenue.',
  the_bridge: 'The pricing conversation script.',
  proof_point: 'Raised rates 3x in six weeks.',
  session_history: [{ role: 'user', content: 'SHOULD NOT APPEAR' }],
  client_language_before: 'SHOULD NOT APPEAR',
}

function reset() {
  leads = [{ id: LEAD, funnel_id: FUNNEL, email: 'lead@example.com', name: 'Lead Person', first_name: null, status: 'lead', application_status: null, opted_in_at: null, created_at: '2026-07-01T00:00:00Z' }]
  funnels = [{ id: FUNNEL, user_id: COACH, subdomain: 'charge-demo', status: 'live', generation_id: GEN, video_url: 'https://video.example.com/v', problem_solution_label: 'Charge Without the Cringe', landing_page: {} }]
  users = {
    [COACH]: { name: 'Jamaul Finley', avatar_url: 'https://img.example.com/avatar.png', bio: 'I help coaches charge more.', profession: 'Pricing coach for service providers', membership_tier: 'full', role: 'member', add_ons: {}, status: 'active' },
    [OTHER]: { name: 'Other Coach', membership_tier: 'full', role: 'member', add_ons: {}, status: 'active' },
  }
  generations = [{ id: GEN, card_id: CARD_FUNNEL, guide_url: 'https://guide.example.com/workbook.pdf' }]
  cards = [
    { id: CARD_FUNNEL, user_id: COACH, card_name: 'Funnel Card', problem_text: 'The funnel problem.', synopsis: SYNOPSIS },
    { id: CARD_PRIMARY, user_id: COACH, card_name: 'Primary Card', problem_text: 'The primary problem.', synopsis: SYNOPSIS_PRIMARY },
    { id: CARD_OTHER_OWNED, user_id: COACH, card_name: 'Third Card', problem_text: 'A third problem.', synopsis: { ...SYNOPSIS, training_title: 'Third Training', transformation: { before: 'THIRD before.', after: 'THIRD after.' } } },
    { id: 'foreign-card', user_id: OTHER, card_name: 'Foreign', problem_text: 'Theirs.', synopsis: SYNOPSIS },
  ]
  savedOutputs = [
    { user_id: COACH, tool_type: 'ai_coach', content: { config: { coach_bot_name: 'Clarity Companion', card_ids: [CARD_PRIMARY, CARD_FUNNEL], goal: 'hybrid', disqualifying_questions: ['q1'], platform: 'claude' }, coach_name: 'Jamaul Finley', bot_name: 'Clarity Companion', system_prompt: 'You are...', deployment_instructions: '', confirmed: true } },
    // Populated on live data, and deliberately NOT the source any more.
    { user_id: COACH, tool_type: 'transformation', content: TRANSFORMATION },
  ]
  businessSettings = { user_id: COACH, business_name: 'Finley Coaching', headshot_url: 'https://img.example.com/headshot.png' }
}

const aiCoachOf = () => savedOutputs.find((s) => s.tool_type === 'ai_coach')

;(async () => {
  const synopsis: Handler = (await import('../api/ai-coach/synopsis')).default
  const profile: Handler = (await import('../api/ai-coach/profile')).default
  const token = signCoachToken(FUNNEL, LEAD)

  console.log('\n-- synopsis: pre-built content only --')
  reset()
  const s = await call(synopsis, token)
  ok('200', s.status === 200, JSON.stringify(s.body).slice(0, 200))
  ok('problem header', s.body?.problem?.card_name === 'Funnel Card' && s.body?.problem?.problem_text === 'The funnel problem.')
  ok('all six synopsis fields', ['audience_quote', 'cost_of_inaction', 'objection_dissolved', 'teaching_outline', 'solution_summary', 'training_title'].every((k) => s.body?.synopsis?.[k] != null), JSON.stringify(Object.keys(s.body?.synopsis || {})))
  ok('transformation is the CARD\'s before/after', s.body?.transformation?.before === 'Pitches from guilt.' && s.body?.transformation?.after === 'Runs calls that diagnose fit.', JSON.stringify(s.body?.transformation))
  ok('transformation has exactly before + after', JSON.stringify(Object.keys(s.body?.transformation || {})) === JSON.stringify(['before', 'after']), JSON.stringify(Object.keys(s.body?.transformation || {})))
  ok('account-level saved_outputs.transformation is NOT the source', !('before_state' in (s.body?.transformation || {})) && !('proof_point' in (s.body?.transformation || {})))
  ok('teaching_outline keeps its structure', Array.isArray(s.body?.synopsis?.teaching_outline))
  ok('does NOT leak high_ticket_pitch / offer_includes / framework_fit', ['high_ticket_pitch', 'offer_includes', 'framework_fit'].every((k) => !(k in (s.body?.synopsis || {}))), JSON.stringify(Object.keys(s.body?.synopsis || {})))
  ok('does NOT leak the raw nested transformation object into synopsis', !('transformation' in (s.body?.synopsis || {})))
  ok('does NOT leak session_history or client_language', !('session_history' in (s.body?.transformation || {})) && !('client_language_before' in (s.body?.transformation || {})))

  console.log('\n-- card resolution: funnel handoff wins when the bot knows it --')
  ok('funnel card chosen (it is in card_ids)', s.body?.problem?.card_id === CARD_FUNNEL, s.body?.problem?.card_id)

  console.log('\n-- ...else the primary blueprint --')
  reset()
  aiCoachOf().content.config.card_ids = [CARD_PRIMARY] // funnel's card not among them
  const s2 = await call(synopsis, token)
  ok('falls back to card_ids[0]', s2.body?.problem?.card_id === CARD_PRIMARY, s2.body?.problem?.card_id)
  ok('and the transformation panel follows that card', s2.body?.transformation?.before === 'PRIMARY before.', JSON.stringify(s2.body?.transformation))
  reset()
  generations = [] // no generation behind the funnel at all
  const s3 = await call(synopsis, token)
  ok('no generation -> primary blueprint', s3.body?.problem?.card_id === CARD_PRIMARY, s3.body?.problem?.card_id)

  console.log('\n-- missing pieces come back null, never invented --')
  reset()
  cards = [{ id: CARD_FUNNEL, user_id: COACH, card_name: 'Funnel Card', problem_text: null, synopsis: { audience_quote: 'only this one' } }]
  savedOutputs = savedOutputs.filter((o) => o.tool_type !== 'transformation')
  const s4 = await call(synopsis, token)
  ok('200 even with a sparse card', s4.status === 200)
  ok('present field kept', s4.body?.synopsis?.audience_quote === 'only this one')
  ok('absent synopsis fields are null', s4.body?.synopsis?.cost_of_inaction === null && s4.body?.synopsis?.training_title === null)
  ok('a card with no synopsis.transformation -> both null, keys intact', Object.keys(s4.body?.transformation || {}).length === 2 && s4.body?.transformation?.before === null && s4.body?.transformation?.after === null, JSON.stringify(s4.body?.transformation))

  console.log('\n-- profile --')
  reset()
  const p = await call(profile, token)
  ok('200', p.status === 200, JSON.stringify(p.body).slice(0, 200))
  ok('coach name prefers business_name', p.body?.coach?.name === 'Finley Coaching')
  ok('tagline from users.profession', p.body?.coach?.tagline === 'Pricing coach for service providers')
  ok('bio', p.body?.coach?.bio === 'I help coaches charge more.')
  ok('photo prefers headshot_url', p.body?.coach?.photo === 'https://img.example.com/headshot.png')
  ok('bot_name from config', p.body?.bot?.bot_name === 'Clarity Companion')
  ok('bot tagline derived from goal', typeof p.body?.bot?.tagline === 'string' && p.body.bot.tagline.length > 0 && p.body?.bot?.goal === 'hybrid')
  ok('video_url from the funnel', p.body?.actions?.video_url === 'https://video.example.com/v')
  ok('guide_url from mtm_generations', p.body?.actions?.guide_url === 'https://guide.example.com/workbook.pdf')

  console.log('\n-- profile fallbacks --')
  reset()
  businessSettings = { user_id: COACH, business_name: null, headshot_url: null }
  const p2 = await call(profile, token)
  ok('falls back to users.name', p2.body?.coach?.name === 'Jamaul Finley')
  ok('falls back to users.avatar_url', p2.body?.coach?.photo === 'https://img.example.com/avatar.png')
  reset()
  users[COACH] = { ...users[COACH], name: null, profession: null, bio: null, avatar_url: null }
  businessSettings = { user_id: COACH, business_name: null, headshot_url: null }
  const p3 = await call(profile, token)
  ok('never blank name', p3.body?.coach?.name === 'Your coach')
  ok('tagline falls back to blank, not null', p3.body?.coach?.tagline === '', JSON.stringify(p3.body?.coach?.tagline))
  ok('bio/photo stay null when absent', p3.body?.coach?.bio === null && p3.body?.coach?.photo === null)
  reset()
  aiCoachOf().content.config.goal = 'book_call'
  const p4 = await call(profile, token)
  ok('book_call tagline differs from hybrid', p4.body?.bot?.tagline !== BOTHYBRID(), p4.body?.bot?.tagline)

  console.log('\n-- the gate: every failure is the SAME not_active shape --')
  for (const [label, mutate] of [
    ['no token', () => {}],
    ['coach not entitled', () => { users[COACH] = { ...users[COACH], membership_tier: 'low_ticket', role: 'member', add_ons: {} } }],
    ['bot generated but NOT confirmed', () => { aiCoachOf().content.confirmed = false }],
    ['no ai_coach at all', () => { savedOutputs = savedOutputs.filter((o) => o.tool_type !== 'ai_coach') }],
    ['lead does not exist', () => { leads = [] }],
    ['funnel does not exist', () => { funnels = [] }],
    ['lead belongs to a DIFFERENT funnel than the token names', () => { leads[0].funnel_id = 'somewhere-else' }],
  ] as [string, () => void][]) {
    reset(); mutate()
    const t = label === 'no token' ? '' : token
    const rs = await call(synopsis, t)
    const rp = await call(profile, t)
    ok(`${label} -> 404 not_active on both`, rs.status === 404 && rs.body?.error === 'not_active' && rp.status === 404 && rp.body?.error === 'not_active', `synopsis ${rs.status}/${JSON.stringify(rs.body)} profile ${rp.status}`)
  }

  console.log('\n-- an entitled coach via add_on or admin still passes --')
  reset(); users[COACH] = { ...users[COACH], membership_tier: 'low_ticket', add_ons: { funnel_builder: true } }
  ok('add_ons.funnel_builder', (await call(synopsis, token)).status === 200)
  reset(); users[COACH] = { ...users[COACH], membership_tier: 'low_ticket', role: 'admin', add_ons: {} }
  ok('role admin', (await call(synopsis, token)).status === 200)

  console.log('\n-- tokens are purpose-scoped: no other lead token opens this --')
  reset()
  ok('a WATCH token is rejected', (await call(synopsis, signWatchToken(FUNNEL, LEAD))).status === 404)
  ok('an OFFER token is rejected', (await call(synopsis, signOfferToken(FUNNEL, LEAD))).status === 404)
  ok('a tampered coach token is rejected', (await call(synopsis, token.slice(0, -3) + 'aaa')).status === 404)
  ok('an expired coach token is rejected', (await call(synopsis, signCoachToken(FUNNEL, LEAD, Date.now() - 40 * 24 * 3600_000))).status === 404)
  ok('a token for another lead resolves to THAT lead, not this one', (await call(synopsis, signCoachToken(FUNNEL, 'nobody'))).status === 404)

  console.log('\n-- token accepted from query and header too --')
  reset()
  ok('?t=', (await call(synopsis, token, 'query')).status === 200)
  ok('x-coach-token', (await call(synopsis, token, 'header')).status === 200)

  console.log('\n-- a card belonging to another coach is never served --')
  reset()
  cards = [{ id: CARD_FUNNEL, user_id: OTHER, card_name: 'Someone Else', problem_text: 'Theirs.', synopsis: SYNOPSIS }]
  aiCoachOf().content.config.card_ids = [CARD_FUNNEL]
  const foreign = await call(synopsis, token)
  ok('404 rather than another coach content', foreign.status === 404, JSON.stringify(foreign.body))

  console.log('\n-- close block: account-level, lead-safe pair only --')
  reset()
  const c1 = await call(synopsis, token)
  ok('proof_point + the_bridge present', c1.body?.close?.proof_point === 'Raised rates 3x in six weeks.' && c1.body?.close?.the_bridge === 'The pricing conversation script.', JSON.stringify(c1.body?.close))
  ok('exactly those two keys', JSON.stringify(Object.keys(c1.body?.close || {})) === JSON.stringify(['proof_point', 'the_bridge']), JSON.stringify(Object.keys(c1.body?.close || {})))
  ok('no session_history / client_language / internal_talk anywhere in the payload', !JSON.stringify(c1.body).includes('SHOULD NOT APPEAR'), JSON.stringify(c1.body).slice(0, 300))
  ok('account before/after_state do NOT ride along in close', !('before_state' in (c1.body?.close || {})) && !('after_state' in (c1.body?.close || {})))
  ok('final top-level shape', JSON.stringify(Object.keys(c1.body || {})) === JSON.stringify(['problem', 'synopsis', 'transformation', 'close']), JSON.stringify(Object.keys(c1.body || {})))
  savedOutputs = savedOutputs.filter((o) => o.tool_type !== 'transformation')
  const c2 = await call(synopsis, token)
  ok('no transformation row -> close keys present but null', Object.keys(c2.body?.close || {}).length === 2 && c2.body?.close?.proof_point === null)

  console.log('\n-- ?card_id= re-resolves the sheet --')
  reset()
  const p1 = await call(synopsis, token, 'bearer', { card_id: CARD_PRIMARY })
  ok('serves the requested card', p1.body?.problem?.card_id === CARD_PRIMARY && p1.body?.problem?.card_name === 'Primary Card', JSON.stringify(p1.body?.problem))
  ok('transformation follows it', p1.body?.transformation?.before === 'PRIMARY before.')
  ok('synopsis follows it', p1.body?.synopsis?.training_title === 'Primary Training')
  ok('close does NOT move (account-level)', p1.body?.close?.proof_point === 'Raised rates 3x in six weeks.')

  console.log('\n-- validation is the coach\'s WHOLE card set, not the bot\'s card_ids --')
  reset()
  ok('a card the coach owns but the bot was not built on is served', (await call(synopsis, token, 'bearer', { card_id: CARD_OTHER_OWNED })).body?.problem?.card_id === CARD_OTHER_OWNED)
  ok('...and its own synopsis comes with it', (await call(synopsis, token, 'bearer', { card_id: CARD_OTHER_OWNED })).body?.transformation?.before === 'THIRD before.')

  console.log('\n-- a bad card_id CLAMPS to the entry problem, never errors at the lead --')
  reset()
  const clampForeign = await call(synopsis, token, 'bearer', { card_id: 'foreign-card' })
  ok('another coach\'s card -> 200, clamped to entry', clampForeign.status === 200 && clampForeign.body?.problem?.card_id === CARD_FUNNEL, `${clampForeign.status} ${JSON.stringify(clampForeign.body?.problem)}`)
  ok('and never serves the foreign card', clampForeign.body?.problem?.card_name !== 'Foreign')
  const clampUnknown = await call(synopsis, token, 'bearer', { card_id: 'does-not-exist' })
  ok('unknown id -> 200, clamped', clampUnknown.status === 200 && clampUnknown.body?.problem?.card_id === CARD_FUNNEL)
  const clampJunk = await call(synopsis, token, 'bearer', { card_id: '' })
  ok('empty card_id -> entry problem', clampJunk.status === 200 && clampJunk.body?.problem?.card_id === CARD_FUNNEL)

  console.log('\n-- card_id does NOT bypass the gate --')
  reset()
  aiCoachOf().content.confirmed = false
  ok('unconfirmed bot still 404s even with a valid card_id', (await call(synopsis, token, 'bearer', { card_id: CARD_PRIMARY })).status === 404)
  reset()
  ok('no token still 404s with a valid card_id', (await call(synopsis, '', 'bearer', { card_id: CARD_PRIMARY })).status === 404)

  console.log('\n-- method guard --')
  reset()
  let st = 0
  const res: any = { setHeader() {}, status(c: number) { st = c; return res }, json() { return res }, end() { return res } }
  await synopsis({ method: 'POST', headers: { authorization: `Bearer ${token}` }, query: {} } as any, res)
  ok('POST 405s', st === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()

function BOTHYBRID() { return 'Ask me anything, and I can help you work out what you need next.' }
