process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub'

// Dynamic imports: the chat handler constructs the Anthropic client at module
// scope from ANTHROPIC_API_KEY, which must be set first.
import { projectSelect } from './support/postgrest'
import { signCoachToken } from '../lib/funnelLeadToken'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const COACH = 'coach-1'
const FUNNEL = 'funnel-1'
const LEAD = 'lead-1'
const OTHER_LEAD = 'lead-2'
const GEN = 'gen-1'
const CARD_A = 'card-a'
const CARD_B = 'card-b'

let leads: any[] = []
let funnels: any[] = []
let users: Record<string, any> = {}
let generations: any[] = []
let cards: any[] = []
let savedOutputs: any[] = []
let messages: any[] = []
let costRows: any[] = []

// What the mock model returns next, and what it was last sent.
let modelResponse: any = null
let lastModelRequest: any = null
// Set to 'user' | 'assistant' to make the multi-row insert reject, as an FK
// violation on resolved_card_id would.
let insertFailsOn: string | null = null

function eqParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? m[1] : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const reqBody = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.anthropic.com')) {
    lastModelRequest = reqBody
    return json(modelResponse)
  }

  if (url.includes('/rest/v1/funnel_leads')) {
    const id = eqParam(url, 'id')
    if (method === 'PATCH') {
      const row = leads.find((l) => l.id === id)
      if (row) Object.assign(row, reqBody)
      return json(row ?? null)
    }
    return json(leads.find((l) => l.id === id) ?? null)
  }
  if (url.includes('/rest/v1/funnels')) return json(funnels.find((f) => f.id === eqParam(url, 'id')) ?? null)
  if (url.includes('/rest/v1/users')) return json(users[eqParam(url, 'id') || ''] ?? null)
  if (url.includes('/rest/v1/mtm_generations')) return json(generations.find((g) => g.id === eqParam(url, 'id')) ?? null)
  if (url.includes('/rest/v1/problem_solution_cards')) {
    const uid = eqParam(url, 'user_id')
    const validated = eqParam(url, 'validated')
    let rows = cards.filter((c) => !uid || c.user_id === uid)
    if (validated === 'true') rows = rows.filter((c) => c.validated === true)
    return json(rows)
  }
  if (url.includes('/rest/v1/saved_outputs')) {
    const uid = eqParam(url, 'user_id'); const tt = eqParam(url, 'tool_type')
    return json(savedOutputs.find((s) => s.user_id === uid && s.tool_type === tt) ?? null)
  }
  if (url.includes('/rest/v1/api_cost_log')) {
    costRows.push(reqBody)
    return json(reqBody, 201)
  }
  if (url.includes('/rest/v1/ai_coach_messages')) {
    const leadId = eqParam(url, 'lead_id')
    if (method === 'POST') {
      // The endpoint sends BOTH turns as one multi-row insert, so the body is
      // an array. insertFailsOn lets a test reject the statement the way a FK
      // violation would — all or nothing, which is the invariant under test.
      const rows = Array.isArray(reqBody) ? reqBody : [reqBody]
      if (insertFailsOn && rows.some((r: any) => r.role === insertFailsOn)) {
        return json({ code: '23503', message: 'insert or update violates foreign key constraint', details: null, hint: null }, 409)
      }
      const written = rows.map((r: any, i: number) => ({ id: `m-${messages.length + i + 1}`, ...r }))
      messages.push(...written)
      return json(written, 201)
    }
    if (method === 'DELETE') {
      messages = messages.filter((m) => m.lead_id !== leadId)
      return json([])
    }
    let rows = messages.filter((m) => m.lead_id === leadId)
    if (/order=created_at\.desc/.test(url)) rows = rows.slice().reverse()
    return json(rows)
  }
  return json([])
}) as typeof fetch

async function call(handler: Handler, token: string, opts: { method?: string; body?: any } = {}) {
  let status = 0, body: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { body = v; return res }, end() { return res } }
  const req: any = { method: opts.method || 'POST', headers: { authorization: `Bearer ${token}` }, body: opts.body, query: {} }
  await handler(req, res)
  return { status, body }
}

function toolResponse(input: Record<string, unknown>, usage?: Record<string, number>) {
  return {
    content: [{ type: 'tool_use', id: 'tu-1', name: 'reply', input }],
    usage: { input_tokens: 900, output_tokens: 120, ...(usage || {}) },
  }
}

// The system prompt is now TWO blocks with a cache breakpoint between them.
const systemBlocks = (): Array<{ text: string; cache_control?: unknown }> =>
  Array.isArray(lastModelRequest?.system) ? lastModelRequest.system : []
const stableBlock = () => systemBlocks()[0]?.text ?? ''
const volatileBlock = () => systemBlocks()[1]?.text ?? ''
const systemText = () => systemBlocks().map((b) => b.text).join('\n\n')

// Fixture cards: LEAK BAIT is planted in the synopsis and audience so the leak
// test can assert on the assembled prompt actually sent to the model.
const SYNOPSIS_A = {
  audience_quote: 'I freeze at the number.',
  solution_summary: 'A tight summary.',
  high_ticket_pitch: 'LEAK_HIGH_TICKET',
  offer_includes: ['LEAK_OFFER_INCLUDES'],
  framework_fit: 'LEAK_FRAMEWORK_FIT',
}

function reset() {
  leads = [
    { id: LEAD, funnel_id: FUNNEL, email: 'lead@example.com', name: 'Lead Person', first_name: 'Lee', status: 'lead', application_status: null, opted_in_at: null, created_at: '2026-07-01T00:00:00Z', ai_coach_turns: 0 },
    { id: OTHER_LEAD, funnel_id: 'funnel-9', email: 'other@example.com', name: 'Other', first_name: null, status: 'lead', application_status: null, opted_in_at: null, created_at: '2026-07-01T00:00:00Z', ai_coach_turns: 0 },
  ]
  funnels = [{ id: FUNNEL, user_id: COACH, subdomain: 'charge-demo', status: 'live', generation_id: GEN, video_url: null, problem_solution_label: 'Charge Without the Cringe', landing_page: {} }]
  users = { [COACH]: { name: 'Jamaul', membership_tier: 'full', role: 'member', add_ons: {}, status: 'active' } }
  generations = [{ id: GEN, card_id: CARD_A, workbook: { title: 'The Guide', sections: [{ sectionTitle: 'S1' }], closing_invite: { book_call: 'book', sell_program: 'sell' } } }]
  cards = [
    { id: CARD_A, user_id: COACH, validated: true, card_name: 'Card A', problem_text: 'Problem A.', source_problem_id: 'p2', reasoning: 'r', suggested_offer: { name: 'x' }, synopsis: SYNOPSIS_A },
    { id: CARD_B, user_id: COACH, validated: true, card_name: 'Card B', problem_text: 'Problem B.', source_problem_id: 'p5', reasoning: 'r', suggested_offer: { name: 'y' }, synopsis: { audience_quote: 'B QUOTE' } },
    { id: 'card-unvalidated', user_id: COACH, validated: false, card_name: 'Unvalidated', problem_text: 'Nope.', source_problem_id: 'p9', reasoning: 'r', suggested_offer: null, synopsis: {} },
  ]
  savedOutputs = [
    { user_id: COACH, tool_type: 'ai_coach', content: { config: { coach_bot_name: 'Companion', card_ids: [CARD_A], goal: 'sell', disqualifying_questions: [], platform: 'claude' }, coach_name: 'Jamaul', bot_name: 'Companion', system_prompt: 'PERSONA_VERBATIM_MARKER. You are Companion.', deployment_instructions: '', confirmed: true } },
    { user_id: COACH, tool_type: 'matcher_analysis', content: { top_10: [{ id: 'p2', problem: 'A', match_factors: { audience_resonance: { score: 10, reasoning: 'FACTOR_FOR_CARD_A' } } }, { id: 'p5', problem: 'B', match_factors: { audience_resonance: { score: 7, reasoning: 'FACTOR_FOR_CARD_B' } } }], session_history: [{ role: 'user', content: 'LEAK_MATCHER_HISTORY' }] } },
    { user_id: COACH, tool_type: 'framework', content: { confirmed: true, phases: [{ name: 'Name it' }] } },
    { user_id: COACH, tool_type: 'core_offers', content: { confirmed: true, offers: [{ name: 'The Signal Intensive', price: '$2,400', tier: 'core' }] } },
    { user_id: COACH, tool_type: 'audience', content: { completed: true, gap_insight: 'safe', session_history: [{ role: 'user', content: 'LEAK_AUDIENCE_HISTORY' }], client_language_before: 'LEAK_CLIENT_LANGUAGE', pricing_internal_talk: 'LEAK_INTERNAL_TALK' } },
  ]
  messages = []
  costRows = []
  lastModelRequest = null
  insertFailsOn = null
  modelResponse = toolResponse({ message: 'Here is a thought.', resolved_card_id: CARD_A, reveal_stage: 'problem' })
}

;(async () => {
  const chat: Handler = (await import('../api/ai-coach/chat')).default
  const workbook: Handler = (await import('../api/ai-coach/workbook')).default
  const { _clearBrainCacheForTests } = await import('../lib/aiCoachContext')
  const { _clearRateLimitForTests } = await import('../lib/rateLimit')
  const token = signCoachToken(FUNNEL, LEAD)
  // Both are module-scope state that outlives a fixture reset: the brain cache
  // would serve a stale coach, and the rate limiter (20/min per lead) would
  // 429 the later blocks of this suite purely because of the earlier ones.
  const freshBrain = () => { _clearBrainCacheForTests(); _clearRateLimitForTests() }

  console.log('\n-- a valid turn writes exactly two rows, in order, pointers on the assistant row only --')
  {
    reset(); freshBrain()
    const r = await call(chat, token, { body: { message: 'I keep undercharging.' } })
    ok('200', r.status === 200, JSON.stringify(r.body))
    ok('reply text returned', r.body?.message === 'Here is a thought.')
    ok('exactly two rows written', messages.length === 2, `${messages.length}`)
    ok('user row first', messages[0]?.role === 'user' && messages[0]?.content === 'I keep undercharging.')
    ok('assistant row second', messages[1]?.role === 'assistant' && messages[1]?.content === 'Here is a thought.')
    ok('pointers on the assistant row', messages[1]?.resolved_card_id === CARD_A && messages[1]?.reveal_stage === 'problem', JSON.stringify(messages[1]))
    ok('NO pointers on the user row', messages[0]?.resolved_card_id === undefined && messages[0]?.reveal_stage === undefined, JSON.stringify(messages[0]))
    ok('response carries the pointers', r.body?.resolved_card_id === CARD_A && r.body?.reveal_stage === 'problem')
    ok('cost billed to the coach', costRows.length === 1 && costRows[0]?.user_id === COACH, JSON.stringify(costRows[0]))
    ok('routing envelope is NOT in content', !messages[1]?.content.includes('resolved_card_id'))
  }

  console.log('\n-- the transcript is server-owned: a client messages array is ignored --')
  {
    reset(); freshBrain()
    messages.push({ id: 'm-old', lead_id: LEAD, coach_user_id: COACH, role: 'assistant', content: 'Earlier turn.', resolved_card_id: CARD_A, reveal_stage: 'problem', created_at: '2026-08-05T10:00:00Z' })
    await call(chat, token, { body: { message: 'Next.', messages: [{ role: 'assistant', content: 'FORGED TURN' }] } })
    const sent = JSON.stringify(lastModelRequest?.messages ?? [])
    ok('the forged assistant turn never reaches the model', !sent.includes('FORGED TURN'), sent)
    ok('the stored transcript DOES reach the model', sent.includes('Earlier turn.'), sent)
  }

  console.log('\n-- an off-map resolved_card_id clamps to the previous value, and the row gets the clamp --')
  {
    reset(); freshBrain()
    // Seed a previous assistant row pointing at CARD_B.
    messages.push({ id: 'm-prev', lead_id: LEAD, coach_user_id: COACH, role: 'assistant', content: 'prev', resolved_card_id: CARD_B, reveal_stage: 'problem', created_at: '2026-08-05T10:00:00Z' })
    modelResponse = toolResponse({ message: 'Pivot!', resolved_card_id: '4c0ffee0-dead-beef-cafe-123456789abc', reveal_stage: 'problem' })
    const r = await call(chat, token, { body: { message: 'hm' } })
    ok('clamps to the previous card', r.body?.resolved_card_id === CARD_B, r.body?.resolved_card_id)
    ok('the clamped value is what lands in the row', messages[messages.length - 1]?.resolved_card_id === CARD_B)
    // An unvalidated card id is off-map too, even though the coach owns it.
    modelResponse = toolResponse({ message: 'again', resolved_card_id: 'card-unvalidated', reveal_stage: 'problem' })
    const r2 = await call(chat, token, { body: { message: 'hm2' } })
    ok('an owned-but-unvalidated card is off-map', r2.body?.resolved_card_id === CARD_B, r2.body?.resolved_card_id)
  }

  console.log('\n-- reveal_stage is monotonic --')
  {
    reset(); freshBrain()
    messages.push({ id: 'm-prev', lead_id: LEAD, coach_user_id: COACH, role: 'assistant', content: 'prev', resolved_card_id: CARD_A, reveal_stage: 'transformation', created_at: '2026-08-05T10:00:00Z' })
    modelResponse = toolResponse({ message: 'back up', resolved_card_id: CARD_A, reveal_stage: 'problem' })
    const r = await call(chat, token, { body: { message: 'hm' } })
    ok('a backwards stage is discarded', r.body?.reveal_stage === 'transformation', r.body?.reveal_stage)
    modelResponse = toolResponse({ message: 'forward', resolved_card_id: CARD_A, reveal_stage: 'full' })
    const r2 = await call(chat, token, { body: { message: 'go on' } })
    ok('a forwards stage advances', r2.body?.reveal_stage === 'full', r2.body?.reveal_stage)
    modelResponse = toolResponse({ message: 'junk stage', resolved_card_id: CARD_A, reveal_stage: 'jackpot' })
    const r3 = await call(chat, token, { body: { message: 'and' } })
    ok('an unknown stage keeps the previous', r3.body?.reveal_stage === 'full', r3.body?.reveal_stage)
  }

  console.log('\n-- the gate: every failure is 404 not_active and writes NOTHING --')
  {
    reset(); freshBrain()
    const expired = signCoachToken(FUNNEL, LEAD, Date.now() - 31 * 24 * 60 * 60 * 1000)
    const wrongLead = signCoachToken(FUNNEL, OTHER_LEAD)
    for (const [label, tok, mutate] of [
      ['expired token', expired, () => {}],
      ['token for another lead', wrongLead, () => {}],
      ['unentitled coach', token, () => { users[COACH].membership_tier = 'workshop' }],
      ['saved-but-unconfirmed ai_coach', token, () => { savedOutputs.find((s) => s.tool_type === 'ai_coach')!.content.confirmed = false }],
    ] as Array<[string, string, () => void]>) {
      reset(); freshBrain(); mutate()
      const r = await call(chat, tok, { body: { message: 'hello' } })
      ok(`${label}: 404 not_active`, r.status === 404 && r.body?.error === 'not_active', `${r.status} ${JSON.stringify(r.body)}`)
      ok(`${label}: nothing written`, messages.length === 0, `${messages.length}`)
    }
  }

  console.log('\n-- no tool block: 200, text carried through, both pointers unchanged --')
  {
    reset(); freshBrain()
    messages.push({ id: 'm-prev', lead_id: LEAD, coach_user_id: COACH, role: 'assistant', content: 'prev', resolved_card_id: CARD_B, reveal_stage: 'transformation', created_at: '2026-08-05T10:00:00Z' })
    modelResponse = { content: [{ type: 'text', text: 'Plain text answer.' }], usage: { input_tokens: 500, output_tokens: 60 } }
    const r = await call(chat, token, { body: { message: 'hm' } })
    ok('200', r.status === 200, `${r.status}`)
    ok('the text block is the message', r.body?.message === 'Plain text answer.')
    ok('previous card kept', r.body?.resolved_card_id === CARD_B)
    ok('previous stage kept', r.body?.reveal_stage === 'transformation')
  }
  {
    reset(); freshBrain()
    modelResponse = { content: [], usage: { input_tokens: 10, output_tokens: 0 } }
    const r = await call(chat, token, { body: { message: 'hm' } })
    ok('an empty response still answers with the fallback line', r.status === 200 && typeof r.body?.message === 'string' && r.body.message.length > 0, JSON.stringify(r.body))
  }

  console.log('\n-- first turn ever: previous card is the entry card, previous stage none --')
  {
    reset(); freshBrain()
    modelResponse = { content: [{ type: 'text', text: 'no tool block' }], usage: { input_tokens: 1, output_tokens: 1 } }
    const r = await call(chat, token, { body: { message: 'first' } })
    ok('entry card used when no assistant row exists', r.body?.resolved_card_id === CARD_A, r.body?.resolved_card_id)
    ok('stage starts at none', r.body?.reveal_stage === 'none', r.body?.reveal_stage)
  }

  console.log('\n-- THE LEAK TEST: what was actually sent to the model --')
  {
    reset(); freshBrain()
    await call(chat, token, { body: { message: 'tell me about pricing' } })
    const system = systemText()
    ok('a system prompt was sent', system.length > 0)
    ok('the persona rides verbatim, first', stableBlock().startsWith('PERSONA_VERBATIM_MARKER'), stableBlock().slice(0, 60))
    for (const leak of ['LEAK_HIGH_TICKET', 'LEAK_OFFER_INCLUDES', 'LEAK_FRAMEWORK_FIT', 'LEAK_MATCHER_HISTORY', 'LEAK_AUDIENCE_HISTORY', 'LEAK_CLIENT_LANGUAGE', 'LEAK_INTERNAL_TALK']) {
      ok(`never leaks: ${leak}`, !system.includes(leak))
    }
    // The discipline cuts both ways — a later over-correction that strips the
    // offers fails HERE.
    ok('core offer NAME appears', system.includes('The Signal Intensive'), 'offer name stripped — over-correction')
    ok('core offer PRICE appears', system.includes('$2,400'), 'offer price stripped — over-correction')
    ok('every validated card is in the map (coverage, not card_ids)', system.includes('Card A') && system.includes('Card B'))
    ok('unvalidated cards are not', !system.includes('Unvalidated'))
    ok('the style guide is present', /WRITING STYLE:/.test(system))
    ok('and rides LAST — after the hosted layer', system.indexOf('WRITING STYLE:') > system.indexOf('REVEAL DISCIPLINE'), `${system.indexOf('WRITING STYLE:')} vs ${system.indexOf('REVEAL DISCIPLINE')}`)
    ok('persona -> hosted layer -> style guide, in that order', system.indexOf('PERSONA_VERBATIM_MARKER') < system.indexOf('HOSTED SESSION LAYER') && system.indexOf('HOSTED SESSION LAYER') < system.indexOf('WRITING STYLE:'))
    ok('the current reveal stage is named in the prompt', system.includes('CURRENT REVEAL STAGE: "none"'))
    ok('the lead\'s first name is in the prompt', system.includes('Lee'))
    ok('the brief-is-already-written constraint is stated', system.includes('THE BRIEF IS ALREADY WRITTEN'))
  }

  console.log('\n-- CACHE BREAKPOINT: what is stable vs what is volatile --')
  // Caching works on PREFIXES — the first differing byte invalidates everything
  // after it. So anything that changes per turn or per lead in the stable block
  // means the cache silently never hits while the code looks correct. These
  // assert the split itself, not just that cache_control exists.
  {
    reset(); freshBrain()
    await call(chat, token, { body: { message: 'hello' } })
    ok('exactly two system blocks', systemBlocks().length === 2, `${systemBlocks().length}`)
    ok('cache_control marks the END of the first block', !!(systemBlocks()[0] as any)?.cache_control, JSON.stringify(systemBlocks()[0]?.cache_control))
    ok('and NOT the volatile one', !(systemBlocks()[1] as any)?.cache_control)
    ok('the TTL is the long one, not the 5m default', (systemBlocks()[0] as any)?.cache_control?.ttl === '1h', JSON.stringify(systemBlocks()[0]?.cache_control))

    // Stable half: persona, index, offers, style guide — nothing per-lead.
    ok('stable block carries the persona', stableBlock().includes('PERSONA_VERBATIM_MARKER'))
    ok('stable block carries the full card index', stableBlock().includes('Card A') && stableBlock().includes('Card B'))
    ok('stable block carries the style guide', /WRITING STYLE:/.test(stableBlock()))
    ok('stable block carries offer names and prices', stableBlock().includes('The Signal Intensive') && stableBlock().includes('$2,400'))

    // Volatile half: everything that moves. Each of these in the stable block
    // would break caching for every turn and every lead.
    ok("the LEAD'S NAME is not in the stable prefix", !stableBlock().includes('Lee'), 'lead name in the cached prefix — cache can never hit across leads')
    ok('the lead name IS in the volatile block', volatileBlock().includes('Lee'))
    ok('the REVEAL STAGE is not in the stable prefix', !/CURRENT REVEAL STAGE/.test(stableBlock()), 'reveal stage in the cached prefix — cache breaks every time it advances')
    ok('the reveal stage IS in the volatile block', /CURRENT REVEAL STAGE: "none"/.test(volatileBlock()))
  }

  console.log('\n-- LAZY SYNOPSIS: index for all, depth for one --')
  {
    reset(); freshBrain()
    await call(chat, token, { body: { message: 'hello' } })
    // Every card is routable, but only the resolved one carries depth.
    ok('the index lists every validated card', stableBlock().includes(CARD_A) && stableBlock().includes(CARD_B))
    ok('no card synopsis is in the stable prefix', !stableBlock().includes('I freeze at the number.') && !stableBlock().includes('B QUOTE'), 'a synopsis leaked into the cached prefix — this is the ~93% that lazy-loading removes')
    ok("the RESOLVED card's synopsis is in the volatile block", volatileBlock().includes('I freeze at the number.'), volatileBlock().slice(0, 300))
    ok("the OTHER card's synopsis is nowhere", !systemText().includes('B QUOTE'), 'an unresolved card\'s synopsis is being sent')

    // Match factors join via source_problem_id -> matcher top_10[].id, NOT the
    // card uuid. Joining on the uuid yields no factors at all, silently.
    ok('match factors joined onto card A', stableBlock().includes('FACTOR_FOR_CARD_A'), 'match factors missing — check the source_problem_id join')
    ok('match factors joined onto card B', stableBlock().includes('FACTOR_FOR_CARD_B'))
  }
  {
    // Pivot: turn N resolves card B, turn N+1 carries B's synopsis.
    reset(); freshBrain()
    modelResponse = toolResponse({ message: 'Actually it is B.', resolved_card_id: CARD_B, reveal_stage: 'problem' })
    const pivot = await call(chat, token, { body: { message: 'ghosted after calls' } })
    ok('the pivot resolves to card B', pivot.body?.resolved_card_id === CARD_B)
    ok("but THIS turn still carried A's synopsis — one turn of lag, by design", volatileBlock().includes('I freeze at the number.'))
    await call(chat, token, { body: { message: 'tell me more' } })
    ok("the NEXT turn carries B's synopsis", volatileBlock().includes('B QUOTE'), volatileBlock().slice(0, 300))
    ok("and no longer A's", !volatileBlock().includes('I freeze at the number.'))
    ok('the cached prefix was untouched by the pivot', stableBlock().includes('PERSONA_VERBATIM_MARKER') && !stableBlock().includes('B QUOTE'))
  }

  console.log('\n-- CACHE ACCOUNTING: a hit is distinguishable from a miss --')
  {
    reset(); freshBrain()
    modelResponse = toolResponse({ message: 'first', resolved_card_id: CARD_A, reveal_stage: 'none' }, { input_tokens: 400, cache_creation_input_tokens: 24000, cache_read_input_tokens: 0 })
    await call(chat, token, { body: { message: 'one' } })
    ok('a MISS records the write count', costRows[0]?.cache_creation_input_tokens === 24000, JSON.stringify(costRows[0]))
    ok('and zero reads', costRows[0]?.cache_read_input_tokens === 0)
    const missCost = Number(costRows[0]?.cost_usd)

    costRows = []
    modelResponse = toolResponse({ message: 'second', resolved_card_id: CARD_A, reveal_stage: 'none' }, { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 24000 })
    await call(chat, token, { body: { message: 'two' } })
    ok('a HIT records the read count', costRows[0]?.cache_read_input_tokens === 24000, JSON.stringify(costRows[0]))
    const hitCost = Number(costRows[0]?.cost_usd)
    ok('a hit costs materially less than a miss', hitCost < missCost, `hit ${hitCost} vs miss ${missCost}`)
    ok('and neither is billed as plain input', costRows[0]?.input_tokens === 400)
  }

  console.log('\n-- ATOMICITY: a turn is two rows or it is none --')
  {
    // The narrow door: the assistant row can fail on its own (an FK violation
    // on resolved_card_id, e.g. a blueprint deleted mid-session while the brain
    // cache still holds its id) and leave the user row committed. One multi-row
    // insert makes the invariant structural.
    reset(); freshBrain()
    insertFailsOn = 'assistant'
    const r = await call(chat, token, { body: { message: 'this turn will fail to write' } })
    ok('the turn fails rather than half-writing', r.status === 500, `${r.status}`)
    ok('ZERO rows landed — no orphaned user turn', messages.length === 0, JSON.stringify(messages))
    insertFailsOn = null
    const retry = await call(chat, token, { body: { message: 'retry' } })
    ok('the retry is clean: exactly two rows', messages.length === 2 && retry.status === 200, `${messages.length}`)
  }
  {
    reset(); freshBrain()
    await call(chat, token, { body: { message: 'ordering' } })
    ok('user row is strictly older than the assistant row', new Date(messages[0].created_at).getTime() < new Date(messages[1].created_at).getTime(), `${messages[0].created_at} vs ${messages[1].created_at}`)
    ok('timestamps are set explicitly, not left to now()', typeof messages[0].created_at === 'string' && typeof messages[1].created_at === 'string')
  }

  console.log('\n-- THE CAP: 20 assistant turns, closing turn, then no model call --')
  {
    reset(); freshBrain()
    const r = await call(chat, token, { body: { message: 'early' } })
    ok('an early turn is open', r.body?.conversation_state === 'open', JSON.stringify(r.body?.conversation_state))
    ok('and the counter incremented', leads[0].ai_coach_turns === 1, `${leads[0].ai_coach_turns}`)
  }
  {
    reset(); freshBrain()
    leads[0].ai_coach_turns = 19
    modelResponse = toolResponse({ message: 'Wrapping up.', resolved_card_id: CARD_A, reveal_stage: 'problem' })
    const r = await call(chat, token, { body: { message: 'one more' } })
    ok('the 20th turn is the closing one', r.body?.conversation_state === 'closing', JSON.stringify(r.body?.conversation_state))
    ok('reveal is FORCED to full, whatever the model said', r.body?.reveal_stage === 'full', r.body?.reveal_stage)
    ok('and that is what lands in the row', messages[1]?.reveal_stage === 'full')
    ok('the closing instruction reached the model', /LAST TURN IN THIS CONVERSATION/.test(volatileBlock()), volatileBlock().slice(-400))
    ok('the CTA is selected by the coach goal (sell)', /getting the program directly/.test(volatileBlock()))
    ok('the model is told NOT to announce a limit', /do not announce a limit/.test(volatileBlock()))
    ok('counter reached the cap', leads[0].ai_coach_turns === 20, `${leads[0].ai_coach_turns}`)
  }
  {
    reset(); freshBrain()
    leads[0].ai_coach_turns = 20
    lastModelRequest = null
    costRows = []
    const r = await call(chat, token, { body: { message: 'still there?' } })
    ok('past the cap the state is closed', r.status === 200 && r.body?.conversation_state === 'closed', JSON.stringify(r.body))
    ok('NO model call was made — this is where the cost bound lives', lastModelRequest === null, JSON.stringify(lastModelRequest)?.slice(0, 120))
    ok('no cost row either', costRows.length === 0)
    ok('nothing was written', messages.length === 0, `${messages.length}`)
    ok('it still says something useful', typeof r.body?.message === 'string' && r.body.message.length > 0)
    ok('and the panel is left fully revealed', r.body?.reveal_stage === 'full')
  }
  {
    // THE LOOPHOLE: Restart clears the thread but must NOT reset the cap.
    reset(); freshBrain()
    leads[0].ai_coach_turns = 20
    messages.push({ id: 'x', lead_id: LEAD, coach_user_id: COACH, role: 'user', content: 'old', created_at: '2026-08-05T10:00:00Z' })
    const del = await call(chat, token, { method: 'DELETE' })
    ok('Restart still clears the transcript', del.status === 200 && !messages.some((m) => m.lead_id === LEAD))
    ok('but the lifetime counter survives it', leads[0].ai_coach_turns === 20, `${leads[0].ai_coach_turns}`)
    lastModelRequest = null
    const after = await call(chat, token, { body: { message: 'fresh start?' } })
    ok('so a restarted lead is still capped', after.body?.conversation_state === 'closed', JSON.stringify(after.body?.conversation_state))
    ok('and still costs no model call', lastModelRequest === null)
  }

  console.log('\n-- DELETE removes only this lead\'s rows --')
  {
    reset(); freshBrain()
    messages.push(
      { id: 'x1', lead_id: LEAD, coach_user_id: COACH, role: 'user', content: 'mine', created_at: '2026-08-05T10:00:00Z' },
      { id: 'x2', lead_id: 'lead-elsewhere', coach_user_id: COACH, role: 'user', content: 'not mine', created_at: '2026-08-05T10:00:00Z' }
    )
    const r = await call(chat, token, { method: 'DELETE' })
    ok('200 ok', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body))
    ok('this lead\'s rows gone', !messages.some((m) => m.lead_id === LEAD))
    ok('another lead\'s rows remain', messages.some((m) => m.lead_id === 'lead-elsewhere'))
  }
  {
    reset(); freshBrain()
    const r = await call(chat, signCoachToken(FUNNEL, LEAD, Date.now() - 31 * 24 * 60 * 60 * 1000), { method: 'DELETE' })
    ok('DELETE behind the same gate', r.status === 404 && r.body?.error === 'not_active')
  }

  console.log('\n-- workbook: lead-authed prose, both CTA variants, null is a 200 --')
  {
    reset(); freshBrain()
    const r = await call(workbook, token, { method: 'GET' })
    ok('200 with the workbook', r.status === 200 && r.body?.workbook?.title === 'The Guide', JSON.stringify(r.body).slice(0, 120))
    ok('closing_invite carries BOTH variants', r.body?.workbook?.closing_invite?.book_call === 'book' && r.body?.workbook?.closing_invite?.sell_program === 'sell')

    funnels[0].generation_id = null
    const r2 = await call(workbook, token, { method: 'GET' })
    ok('null generation is { workbook: null } with 200, not 404', r2.status === 200 && r2.body?.workbook === null, `${r2.status} ${JSON.stringify(r2.body)}`)

    reset(); freshBrain()
    const r3 = await call(workbook, signCoachToken(FUNNEL, OTHER_LEAD), { method: 'GET' })
    ok('workbook sits behind the same gate', r3.status === 404 && r3.body?.error === 'not_active')
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
