process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic'

import { createSessionToken } from '../lib/auth'
import { reshapeProgram, sessionCountFor, SESSION_CADENCES, type SessionCadence } from '../lib/programReshape'
import type { FrameworkPhase } from '../lib/frameworkAnalysis'
import type { ProgramAnalysis } from '../lib/programAnalysis'

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

const USER = 'coach-1'
const PRICE = '$4,800'

function step(id: string, n: string) {
  return { id, name: n, description: `${n} description`, outcome: `${n} outcome` }
}

// NINE steps — three phases of three. The maximum the framework generator
// allows.
const PHASES_9: FrameworkPhase[] = [
  { id: 'p1', name: 'Diagnose', tagline: 't1', color: 'c', steps: [step('p1s1', 'Name the problem'), step('p1s2', 'Audit the last 90 days'), step('p1s3', 'Score the signals')] },
  { id: 'p2', name: 'Rebuild', tagline: 't2', color: 'c', steps: [step('p2s1', 'Rewrite the opening'), step('p2s2', 'Run it live'), step('p2s3', 'Lock the script')] },
  { id: 'p3', name: 'Scale', tagline: 't3', color: 'c', steps: [step('p3s1', 'Map the loop'), step('p3s2', 'Price the offer'), step('p3s3', 'Hand it over')] },
]

// SIX steps — three phases of two. The generator permits 2 OR 3 steps per phase,
// so "nine steps" is the maximum and not the invariant. A distribution tested
// only against nine would let an off-by-one that happens to divide cleanly at
// nine survive, which is the whole reason both fixtures exist. Held to one
// variable: same phase count, same names, only the step count differs.
const PHASES_6: FrameworkPhase[] = [
  { id: 'p1', name: 'Diagnose', tagline: 't1', color: 'c', steps: [step('p1s1', 'Name the problem'), step('p1s2', 'Audit the last 90 days')] },
  { id: 'p2', name: 'Rebuild', tagline: 't2', color: 'c', steps: [step('p2s1', 'Rewrite the opening'), step('p2s2', 'Run it live')] },
  { id: 'p3', name: 'Scale', tagline: 't3', color: 'c', steps: [step('p3s1', 'Map the loop'), step('p3s2', 'Price the offer')] },
]

function baseProgram(): ProgramAnalysis {
  return {
    program_name: 'The Waitlist Method',
    session_type: '1:1',
    total_weeks: 12,
    total_sessions: 12,
    session_length_minutes: 60,
    timeline_reasoning: 'Twelve weeks is the right length because the client needs 12 weeks to embed the work.',
    weekly_breakdown: Array.from({ length: 12 }, (_, i) => ({
      week: i + 1,
      phase_name: 'Diagnose',
      session_focus: `generated focus ${i + 1}`,
      client_milestone: `generated milestone ${i + 1}`,
    })),
    deliverables: ['A scored enquiry log', 'A rewritten sales call', 'A referral script', 'A pricing page'],
    suggested_starting_price: PRICE,
    suggested_capacity_per_month: 8,
    confirmed: false,
  }
}

// The predicate, written out INDEPENDENTLY of the code under test. Calling
// reshapeProgram's own helpers here would move the rule and the check together
// and the suite would agree with whatever the lib did.
function allStepIds(phases: FrameworkPhase[]): string[] {
  const out: string[] = []
  for (const p of phases) for (const s of p.steps) out.push(s.id)
  return out
}
// Which phase each step belongs to, built from the fixture rather than asked of
// the lib.
function phaseOfStep(phases: FrameworkPhase[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of phases) for (const st of p.steps) out[st.id] = p.name
  return out
}
function referencedStepIds(program: ProgramAnalysis): string[] {
  const out: string[] = []
  for (const entry of program.weekly_breakdown) for (const id of entry.step_ids || []) out.push(id)
  return out
}

// ── stub ────────────────────────────────────────────────────────────────────
type Row = { tool_type: string; content: any; updated_at: string }
let rows: Row[] = []
let writes: { tool_type: string; content: any }[] = []

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-06-01T00:00:00.000Z' // later than T0

function seed(opts: { staleCoreOffers?: boolean } = {}) {
  rows = [
    { tool_type: 'audience', content: { completed: true }, updated_at: T0 },
    { tool_type: 'transformation', content: {}, updated_at: T0 },
    { tool_type: 'matcher_intake', content: {}, updated_at: T0 },
    {
      tool_type: 'transformation_analysis',
      content: { confirmed: true, sync_snapshot: { transformation: T0 } },
      updated_at: T0,
    },
    {
      tool_type: 'framework',
      content: {
        confirmed: true,
        frameworkName: 'The Waitlist Method',
        frameworkTagline: 'tag',
        phases: PHASES_9,
        sync_snapshot: { audience: T0, transformation_analysis: T0 },
      },
      // When core_offers must be stale, the framework it depends on has moved
      // AFTER core_offers recorded its snapshot. That is a real upstream edit,
      // not a mocked gate result.
      updated_at: opts.staleCoreOffers ? T1 : T0,
    },
    {
      tool_type: 'core_offers',
      content: {
        confirmed: true,
        high_ticket: { price_point: PRICE },
        sync_snapshot: { audience: T0, transformation_analysis: T0, framework: T0, matcher_intake: T0 },
      },
      updated_at: T0,
    },
    { tool_type: 'program', content: baseProgram(), updated_at: T0 },
  ]
  writes = []
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(b === null ? 'null' : JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    return json({ id: USER, status: 'active', role: 'user', membership_tier: 'full' })
  }
  if (url.includes('/rest/v1/problem_solution_cards')) return json([])
  if (url.includes('/rest/v1/mtm_generations')) return json([])

  if (url.includes('/rest/v1/saved_outputs')) {
    if (method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body
      writes.push({ tool_type: row.tool_type, content: row.content })
      const existing = rows.find((r) => r.tool_type === row.tool_type)
      if (existing) existing.content = row.content
      else rows.push({ tool_type: row.tool_type, content: row.content, updated_at: T0 })
      return json(row)
    }
    const m = /tool_type=eq\.([^&]+)/.exec(url)
    const inM = /tool_type=in\.\((.*?)\)(?=&|$)/.exec(url)
    if (m) {
      const r = rows.find((x) => x.tool_type === m[1])
      return json(r ? { tool_type: r.tool_type, content: r.content, updated_at: r.updated_at } : null)
    }
    if (inM) {
      const wanted = inM[1].split(',').map((s) => s.replace(/^"|"$/g, ''))
      return json(rows.filter((r) => wanted.includes(r.tool_type)).map((r) => ({ tool_type: r.tool_type, content: r.content, updated_at: r.updated_at })))
    }
    return json(rows.map((r) => ({ tool_type: r.tool_type, content: r.content, updated_at: r.updated_at })))
  }
  return json([])
}) as typeof fetch

async function callReshape(handler: Handler, body: unknown) {
  const token = await createSessionToken(USER)
  let status = 0
  let resBody: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { resBody = v; return res },
    end() { return res },
  }
  await handler({ headers: { authorization: `Bearer ${token}` }, method: 'POST', body, query: {} } as any, res)
  return { status, body: resBody }
}

;(async () => {
  const { default: reshapeHandler } = await import('../api/matcher/program/reshape')
  const FW9 = { frameworkName: 'The Waitlist Method', phases: PHASES_9 }
  const FW6 = { frameworkName: 'The Waitlist Method', phases: PHASES_6 }

  console.log('\n-- 1. eight weeks weekly: eight sessions, every step, none invented --')
  {
    seed()
    const r = await callReshape(reshapeHandler, { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 60 })
    eq('200', r.status, 200)
    const p = r.body as ProgramAnalysis
    eq('total_weeks', p.total_weeks, 8)
    eq('total_sessions', p.total_sessions, 8)
    eq('and the breakdown has one entry per session', p.weekly_breakdown.length, 8)

    const expected = allStepIds(PHASES_9)
    const got = referencedStepIds(p)
    eq('every step is referenced exactly once', [...got].sort(), [...expected].sort())
    eq('and none was invented', got.filter((id) => !expected.includes(id)), [])
    // 8 sessions, 9 steps — so one session necessarily carries two.
    ok('one session carries two steps, since nine will not fit in eight', p.weekly_breakdown.some((e) => (e.step_ids || []).length === 2))
  }

  console.log('\n-- 2. twelve weeks bi-weekly: twelve weeks, SIX sessions --')
  {
    seed()
    const r = await callReshape(reshapeHandler, { total_weeks: 12, session_cadence: 'biweekly', session_length_minutes: 90 })
    const p = r.body as ProgramAnalysis
    // Asserted SEPARATELY on purpose. These have been the same number in every
    // row that exists, which is the condition under which two fields quietly
    // become one — twelve weeks bi-weekly is six sessions across twelve weeks,
    // not six weeks.
    eq('total_weeks is still twelve', p.total_weeks, 12)
    eq('total_sessions is six', p.total_sessions, 6)
    ok('and they are NOT the same number', p.total_weeks !== p.total_sessions)
    eq('sessions land on odd weeks', p.weekly_breakdown.map((e) => e.week), [1, 3, 5, 7, 9, 11])
    eq('every step survives the halving', [...referencedStepIds(p)].sort(), [...allStepIds(PHASES_9)].sort())
  }

  console.log('\n-- 3. monthly at twelve weeks: three sessions, three phases, all steps --')
  {
    seed()
    const r = await callReshape(reshapeHandler, { total_weeks: 12, session_cadence: 'monthly', session_length_minutes: 120 })
    const p = r.body as ProgramAnalysis
    eq('total_sessions is three', p.total_sessions, 3)
    eq('total_weeks is still twelve', p.total_weeks, 12)

    // The smallest shape is where a phase is most likely to be dropped.
    const phaseNames = p.weekly_breakdown.map((e) => e.phase_name)
    eq('all three phases are represented', [...new Set(phaseNames)].sort(), ['Diagnose', 'Rebuild', 'Scale'])
    eq('and every step is still present', [...referencedStepIds(p)].sort(), [...allStepIds(PHASES_9)].sort())
  }

  console.log('\n-- 4. the price does not move --')
  {
    seed()
    const before = (rows.find((r) => r.tool_type === 'program')!.content as ProgramAnalysis).suggested_starting_price
    for (const shape of [
      { total_weeks: 4, session_cadence: 'weekly' as const },
      { total_weeks: 16, session_cadence: 'biweekly' as const },
      { total_weeks: 12, session_cadence: 'monthly' as const },
    ]) {
      const r = await callReshape(reshapeHandler, { ...shape, session_length_minutes: 60 })
      const p = r.body as ProgramAnalysis
      // Byte-identical string comparison, not a numeric one — the stored value
      // is '$4,800' and a recalculation would show up as a different string
      // long before it showed up as a different number.
      eq(`  price unchanged at ${shape.total_weeks}w ${shape.session_cadence}`, p.suggested_starting_price, before)
      eq(`  and so are the deliverables`, p.deliverables, baseProgram().deliverables)
      eq(`  and the program name`, p.program_name, baseProgram().program_name)
      eq(`  and the session type`, p.session_type, baseProgram().session_type)
    }
  }

  console.log('\n-- 5. the reasoning describes the shape that was chosen --')
  {
    seed()
    const r = await callReshape(reshapeHandler, { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 45 })
    const p = r.body as ProgramAnalysis
    const reasoning = p.timeline_reasoning

    ok('it names the new week count', /\b8 weeks\b/.test(reasoning), reasoning)
    // The point of rewriting it: a paragraph arguing for twelve weeks under an
    // eight-week plan is worse than none.
    ok('it does NOT still say twelve', !/\b12\b/.test(reasoning) && !/twelve/i.test(reasoning), reasoning)
    ok('and none of the generated paragraph survives', !reasoning.includes('embed the work'), reasoning)
    ok('it names the cadence', /every week/.test(reasoning), reasoning)
    ok('and the session length', /45 minutes/.test(reasoning), reasoning)
  }

  console.log('\n-- 6. 409 out_of_sync, reached by moving an upstream artifact --')
  {
    // NOT mocked: the framework row's updated_at is moved past the timestamp
    // core_offers recorded in its own sync_snapshot, so the real
    // computeStaleness marks core_offers stale, and core_offers is a declared
    // dependency of program.
    seed({ staleCoreOffers: true })
    const before = JSON.stringify(rows.find((r) => r.tool_type === 'program')!.content)

    const r = await callReshape(reshapeHandler, { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 60 })
    eq('409', r.status, 409)
    eq('out_of_sync', r.body?.error, 'out_of_sync')
    ok('it names what is blocking', Array.isArray(r.body?.blocking) && r.body.blocking.includes('core_offers'), JSON.stringify(r.body?.blocking))
    eq('and NOTHING was written', writes.length, 0)
    eq('the stored program is untouched', JSON.stringify(rows.find((r) => r.tool_type === 'program')!.content), before)

    // The control: the same request succeeds once the upstream is back in sync.
    // Without it, an endpoint that 409s unconditionally would pass the above.
    seed()
    const okRes = await callReshape(reshapeHandler, { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 60 })
    eq('and in-sync, the same request is accepted', okRes.status, 200)
  }

  console.log('\n-- 7. a bad cadence is refused with a sentence, and writes nothing --')
  {
    for (const bad of ['fortnightly', 'WEEKLY', 2, null, '', 'daily']) {
      seed()
      const before = JSON.stringify(rows.find((r) => r.tool_type === 'program')!.content)
      const r = await callReshape(reshapeHandler, { total_weeks: 8, session_cadence: bad, session_length_minutes: 60 })
      eq(`  ${JSON.stringify(bad)} -> 400`, r.status, 400)
      ok(`  ${JSON.stringify(bad)} explains itself in a sentence`, typeof r.body?.message === 'string' && r.body.message.length > 30 && r.body.message.includes('weekly'), JSON.stringify(r.body))
      eq(`  ${JSON.stringify(bad)} wrote nothing`, writes.length, 0)
      eq(`  ${JSON.stringify(bad)} left the row untouched`, JSON.stringify(rows.find((r) => r.tool_type === 'program')!.content), before)
    }

    // Out of range on the other two inputs, same posture.
    for (const body of [
      { total_weeks: 0, session_cadence: 'weekly', session_length_minutes: 60 },
      { total_weeks: 17, session_cadence: 'weekly', session_length_minutes: 60 },
      { total_weeks: 8.5, session_cadence: 'weekly', session_length_minutes: 60 },
      { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 0 },
      { total_weeks: 8, session_cadence: 'weekly', session_length_minutes: 10_000 },
    ]) {
      seed()
      const r = await callReshape(reshapeHandler, body)
      eq(`  ${JSON.stringify(body)} -> 400`, r.status, 400)
      eq(`  and wrote nothing`, writes.length, 0)
    }
  }

  console.log('\n-- the property, swept: EVERY shape keeps every step --')
  {
    // The acceptance names three shapes. A distribution can satisfy three and
    // still drop a step at 5 weeks monthly, so every legal shape is exercised
    // against BOTH framework sizes — nine steps and six. Testing only nine
    // would let an off-by-one that happens to divide cleanly there survive.
    let checked = 0
    const distribution: Record<string, number> = {}

    for (const phases of [PHASES_9, PHASES_6]) {
      const fw = { frameworkName: 'The Waitlist Method', phases }
      const expected = allStepIds(phases)
      for (let weeks = 1; weeks <= 16; weeks++) {
        for (const cadence of SESSION_CADENCES) {
          const p = reshapeProgram(baseProgram(), fw, {
            total_weeks: weeks,
            session_cadence: cadence,
            session_length_minutes: 60,
          })
          const got = referencedStepIds(p)
          const sessions = sessionCountFor(weeks, cadence as SessionCadence)

          // Reported as a DISTRIBUTION rather than a failure count: a sweep that
          // says "0 failures" reads identically whether it checked everything or
          // nothing. This says how many of each shape it actually saw.
          const bucket = sessions < phases.length ? 'fewer sessions than phases' : sessions < expected.length ? 'fewer sessions than steps' : 'a session per step or more'
          distribution[bucket] = (distribution[bucket] || 0) + 1

          if ([...new Set(got)].sort().join() !== [...expected].sort().join()) {
            ok(`${expected.length} steps / ${weeks}w ${cadence}: every step present`, false, `got ${JSON.stringify(got)}`)
            return
          }
          if (p.weekly_breakdown.length !== sessions) {
            ok(`${expected.length} steps / ${weeks}w ${cadence}: one entry per session`, false, `${p.weekly_breakdown.length} vs ${sessions}`)
            return
          }
          if (p.weekly_breakdown.some((e) => !(e.step_ids || []).length)) {
            ok(`${expected.length} steps / ${weeks}w ${cadence}: no empty session`, false, JSON.stringify(p.weekly_breakdown))
            return
          }
          // A SESSION MUST NOT STRADDLE TWO PHASES whenever there is room to
          // avoid it. Found by mutation: weakening the one-session-per-phase
          // floor still left every phase and every step present, so the suite
          // stayed green — while producing a session labelled "Diagnose" that
          // contained a "Rebuild" step. All phases appearing is a weaker
          // property than every session being what it says it is, and the coach
          // reads the label.
          if (sessions >= phases.length) {
            const owner = phaseOfStep(phases)
            const straddled = p.weekly_breakdown.find((e) => (e.step_ids || []).some((id) => owner[id] !== e.phase_name))
            if (straddled) {
              ok(
                `${expected.length} steps / ${weeks}w ${cadence}: no session straddles two phases`,
                false,
                `session labelled ${straddled.phase_name} holds ${JSON.stringify(straddled.step_ids)} owned by ${JSON.stringify((straddled.step_ids || []).map((id) => owner[id]))}`
              )
              return
            }
          }
          checked++
        }
      }
    }

    eq('every legal shape was exercised across both framework sizes', checked, 16 * 3 * 2)
    ok('and all three density regimes were actually reached', Object.keys(distribution).length === 3, JSON.stringify(distribution))
    console.log('       shapes by regime:', JSON.stringify(distribution))
  }

  console.log('\n-- every legal phase shape, at the smallest container --')
  {
    // The framework generator allows 2 OR 3 steps per phase, so there are eight
    // legal shapes. Three sessions against three phases is where a phase is
    // most likely to be dropped AND where an uneven split is most likely to
    // straddle — 2+2+3 and 3+2+2 divide differently, and a fixture that only
    // ever used 3+3+3 divides cleanly and proves neither.
    const owner9 = phaseOfStep(PHASES_9)
    for (const sizes of [[2, 2, 2], [2, 2, 3], [2, 3, 2], [2, 3, 3], [3, 2, 2], [3, 2, 3], [3, 3, 2], [3, 3, 3]]) {
      const phases: FrameworkPhase[] = sizes.map((n, i) => ({
        id: `p${i + 1}`,
        name: `P${i + 1}`,
        tagline: 't',
        color: 'c',
        steps: Array.from({ length: n }, (_, j) => step(`p${i + 1}s${j + 1}`, `P${i + 1}S${j + 1}`)),
      }))
      const owner = phaseOfStep(phases)
      const p = reshapeProgram(baseProgram(), { frameworkName: 'F', phases }, {
        total_weeks: 12,
        session_cadence: 'monthly',
        session_length_minutes: 60,
      })
      const label = sizes.join('+')
      eq(`  ${label}: every step present`, [...referencedStepIds(p)].sort(), [...allStepIds(phases)].sort())
      eq(`  ${label}: all three phases present`, [...new Set(p.weekly_breakdown.map((e) => e.phase_name))].length, 3)
      ok(
        `  ${label}: no session straddles two phases`,
        p.weekly_breakdown.every((e) => (e.step_ids || []).every((id) => owner[id] === e.phase_name)),
        JSON.stringify(p.weekly_breakdown.map((e) => `${e.phase_name}[${(e.step_ids || []).join(',')}]`))
      )
    }
    void owner9
  }

  console.log('\n-- and when sessions outnumber steps, no step is skipped either --')
  {
    // 16 weekly against six steps: more room than content. Every step must
    // still appear, and consecutive sessions hold one step rather than a
    // session sitting empty.
    const p = reshapeProgram(baseProgram(), FW6, { total_weeks: 16, session_cadence: 'weekly', session_length_minutes: 60 })
    eq('sixteen sessions', p.total_sessions, 16)
    eq('all six steps appear', [...new Set(referencedStepIds(p))].sort(), [...allStepIds(PHASES_6)].sort())
    ok('every session has something in it', p.weekly_breakdown.every((e) => (e.step_ids || []).length >= 1))
    eq('all three phases still appear', [...new Set(p.weekly_breakdown.map((e) => e.phase_name))].sort(), ['Diagnose', 'Rebuild', 'Scale'])
  }

  console.log('\n-- a wrong method answers 405, not 401 --')
  {
    // The route's shape has to be answerable without a session: 104 of 123
    // handlers check the method first, and the frontend's route manifest infers
    // from the status. An auth-first route answers 401 to a GET where every
    // neighbour answers 405, and reads as a different kind of route.
    let status = 0
    const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json() { return res }, end() { return res } }
    const { default: h } = await import('../api/matcher/program/reshape')
    await (h as Handler)({ headers: {}, method: 'GET', body: undefined, query: {} } as any, res)
    eq('an unauthenticated GET is 405', status, 405)
  }

  console.log('\n-- session content comes from the framework, not from paraphrase --')
  {
    const p = reshapeProgram(baseProgram(), FW9, { total_weeks: 9, session_cadence: 'weekly', session_length_minutes: 60 })
    const first = p.weekly_breakdown[0]
    eq('the focus is the step name', first.session_focus, 'Name the problem')
    eq("and the milestone is that step's own stated outcome", first.client_milestone, 'Name the problem outcome')
    ok('none of the generated prose survived', !p.weekly_breakdown.some((e) => e.session_focus.startsWith('generated')))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
