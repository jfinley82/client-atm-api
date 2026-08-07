process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { projectSelect } from './support/postgrest'

// The journey exists so the frontend renders "Step N of total_steps" from the
// response, never from a constant of its own. These tests pin the sixth step
// (Funnel Builder) and the two constants that must move together — total_steps
// and the firstIncomplete fallback. Missing the fallback strands a member who
// finished everything on step 5 forever.

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const USER = 'user-1'

// Per-table fixtures the fetch mock serves.
let savedOutputs: any[] = []
let validatedCards: any[] = []
let generations: any[] = []
let funnels: any[] = []

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(projectSelect(url, b)), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/saved_outputs')) return json(savedOutputs)
  if (url.includes('/rest/v1/problem_solution_cards')) return json(validatedCards)
  if (url.includes('/rest/v1/mtm_generations')) return json(generations)
  if (url.includes('/rest/v1/funnels')) {
    // The signal must be status-based, so the mock honours the filter rather
    // than returning everything — a query without status=eq.live gets all rows,
    // which is exactly the wrong-signal case the test below pins.
    const status = eqParam(url, 'status')
    return json(status ? funnels.filter((f) => f.status === status) : funnels)
  }
  return json([])
}) as typeof fetch

// A row set where steps 1-5 are all genuinely complete.
function completeThroughLaunch() {
  savedOutputs = [
    { tool_type: 'audience', content: { completed: true } },
    { tool_type: 'transformation', content: { completed: true } },
    { tool_type: 'framework', content: { confirmed: true } },
    { tool_type: 'core_offers', content: { confirmed: true } },
    { tool_type: 'program', content: { confirmed: true } },
  ]
  validatedCards = [{ id: 'card-1' }]
  generations = [{
    card_id: 'card-1',
    slides: [{ slideTitle: 'S' }],
    emails: [{ body: 'b' }],
    book_a_call_emails: [{ body: 'b' }],
    workbook: { sections: [{ sectionTitle: 'S' }] },
  }]
  funnels = []
}

;(async () => {
  const { getMtmJourney } = await import('../lib/progress')

  console.log('\n-- the journey has six steps, and says so --')
  {
    completeThroughLaunch()
    const j = await getMtmJourney(USER)
    ok('total_steps is 6', j.total_steps === 6, `${j.total_steps}`)
    ok('six steps returned', j.steps.length === 6, `${j.steps.length}`)
    ok('the sixth is keyed funnel, numbered 6', j.steps[5]?.key === 'funnel' && j.steps[5]?.number === 6, JSON.stringify(j.steps[5]))
    ok('keys stay lowercase single words', j.steps.every((s) => /^[a-z]+$/.test(s.key)), JSON.stringify(j.steps.map((s) => s.key)))
    ok('signals carries funnel_live', typeof j.signals.funnel_live === 'boolean')
  }

  console.log('\n-- the workwithjamaul case: a DRAFT funnel is not a completed step --')
  {
    completeThroughLaunch()
    funnels = [{ id: 'f-1', status: 'draft', subdomain: null }]
    const j = await getMtmJourney(USER)
    ok('funnel_live is false', j.signals.funnel_live === false)
    ok('step 6 is incomplete', j.steps[5].complete === false)
    ok('current_step is 6', j.current_step === 6, `${j.current_step}`)
    ok('unlocked_through is 6', j.unlocked_through === 6, `${j.unlocked_through}`)
    ok('steps 1-5 stay complete', j.steps.slice(0, 5).every((s) => s.complete), JSON.stringify(j.steps))
  }

  console.log('\n-- the teamfinley21 case: a LIVE funnel completes step 6 --')
  {
    completeThroughLaunch()
    funnels = [{ id: 'f-2', status: 'live', subdomain: 'charge-demo' }]
    const j = await getMtmJourney(USER)
    ok('funnel_live is true', j.signals.funnel_live === true)
    ok('step 6 is complete', j.steps[5].complete === true)
    // THE FALLBACK: everything complete must report 6, not 5. This is the
    // second constant the brief warns about.
    ok('a fully-complete member sits on step 6, not 5', j.current_step === 6, `${j.current_step}`)
    ok('unlocked_through is 6', j.unlocked_through === 6, `${j.unlocked_through}`)
  }

  console.log('\n-- no funnels at all: false, not an error --')
  {
    completeThroughLaunch()
    funnels = []
    const j = await getMtmJourney(USER)
    ok('funnel_live is false with zero rows', j.signals.funnel_live === false)
    ok('no throw, journey intact', j.steps.length === 6)
  }

  console.log('\n-- status is the signal, not row presence --')
  {
    // Multiple non-live rows must not complete the step; one live row among
    // drafts must.
    completeThroughLaunch()
    funnels = [
      { id: 'f-3', status: 'draft' },
      { id: 'f-4', status: 'archived' },
    ]
    ok('drafts and archived do not count', (await getMtmJourney(USER)).signals.funnel_live === false)
    funnels.push({ id: 'f-5', status: 'live' })
    ok('one live row among drafts does', (await getMtmJourney(USER)).signals.funnel_live === true)
  }

  console.log('\n-- the monotonic backfill covers the new entry --')
  {
    // A live funnel with nothing else on the account: structurally impossible
    // in the product, and exactly what the backfill exists to display sanely.
    savedOutputs = []
    validatedCards = []
    generations = []
    funnels = [{ id: 'f-6', status: 'live' }]
    const j = await getMtmJourney(USER)
    ok('a complete step 6 backfills 1-5', j.steps.every((s) => s.complete), JSON.stringify(j.steps))
    ok('current_step reads 6', j.current_step === 6, `${j.current_step}`)
  }
  {
    // And a genuinely fresh account starts at step 1 — the new sixth entry must
    // not have disturbed the bottom of the ladder.
    savedOutputs = []; validatedCards = []; generations = []; funnels = []
    const j = await getMtmJourney(USER)
    ok('a fresh account sits on step 1', j.current_step === 1, `${j.current_step}`)
    ok('with nothing complete', j.steps.every((s) => !s.complete))
  }

  console.log('\n-- build_gate is untouched by any of this --')
  {
    completeThroughLaunch()
    savedOutputs.push({ tool_type: 'build_selection', content: { card_id: 'card-9' } })
    funnels = [{ id: 'f-7', status: 'live' }]
    const j = await getMtmJourney(USER)
    ok('explicit selection still wins', j.build_gate.selected_card_id === 'card-9', JSON.stringify(j.build_gate))
    ok('blueprint_selected still derived from it', j.build_gate.blueprint_selected === true)
  }

  console.log('\n-- the assistant checklist is a DIFFERENT list and stayed one --')
  {
    // Both surfaces now have six entries; that is a coincidence, not a
    // relationship. The checklist's own keys must not have been rewritten to
    // the journey's, and lib/assistantContext.ts must not import the journey.
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/assistantContext.ts'), 'utf8')
    for (const key of ['watch_training', 'attract', 'transform', 'monetize', 'blueprint', 'assets']) {
      ok(`checklist still carries '${key}'`, src.includes(`'${key}'`), `missing ${key}`)
    }
    ok('the checklist does not import the journey', !/getMtmJourney/.test(src))
    ok("and has no 'funnel' step of its own", !/key: 'funnel'/.test(src))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
