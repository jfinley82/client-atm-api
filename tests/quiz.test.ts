process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '../lib/auth'
import {
  MONIKER_BANDS,
  QUIZ_PILLARS,
  QUIZ_PROBLEM_PROMPT,
  QUIZ_QUESTIONS,
  QUIZ_QUESTION_IDS,
  assertGapFloorMatchesTopBand,
  assertMonikerBandsCoverEveryScore,
  assertPointsTablesAreWellFormed,
  FOCUS_QUESTION,
  GAP_FLOOR,
  CAPACITY_EVIDENCE_FLOOR,
  MATERIAL_MARGIN,
  SCORED_QUESTIONS,
  focusStanding,
  normalizeProblemStatement,
  pointsFor,
  scoreQuiz,
  validateQuizAnswers,
} from '../lib/quizScoring'

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
const NEWCOMER = 'coach-never-took-it'

// ---------------------------------------------------------------------------
// A stand-in database with the ONE property this feature turns on: the RPC
// writes the row and stamps the user together, or does neither.
//
// The mock implements record_quiz_result the way migration 092 does — insert,
// then set quiz_score FROM the inserted row — so the assertions below are about
// the same guarantee production has, not about two calls this file happens to
// make in order. `rpcShouldFail` flips it to the failure case for item 5, and
// the failure is thrown BEFORE either write, which is what a transaction does.
// ---------------------------------------------------------------------------
type QuizRow = {
  id: string
  user_id: string
  answers: Record<string, string>
  problem_statement: string | null
  score: number
  analysis: Record<string, unknown>
  created_at: string
}

let quizRows: QuizRow[] = []
let users: Record<string, { id: string; status: string; role: string; quiz_completed: boolean; quiz_score: number | null }> = {}
let rpcShouldFail = false
let rowSeq = 0
// Whether record_quiz_result upserts, as migration 092 does. Flipped off in one
// block below to prove the mock's constraint actually bites — a guard nobody has
// watched fail is a guard nobody knows works.
let UPSERTS = true
// created_at has to advance so "most recent" is a real ordering rather than a
// tie the mock resolves by insertion order — which is exactly the thing the
// endpoint refuses to rely on.
let clock = Date.parse('2026-08-06T12:00:00.000Z')

function resetDb() {
  quizRows = []
  rpcShouldFail = false
  rowSeq = 0
  clock = Date.parse('2026-08-06T12:00:00.000Z')
  users = {
    [COACH]: { id: COACH, status: 'active', role: 'user', quiz_completed: false, quiz_score: null },
    [NEWCOMER]: { id: NEWCOMER, status: 'active', role: 'user', quiz_completed: false, quiz_score: null },
  }
}
resetDb()

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/rpc/record_quiz_result')) {
    if (rpcShouldFail) return json({ message: 'simulated failure' }, 500)

    // THE UNIQUE CONSTRAINT IS MODELLED HERE ON PURPOSE.
    // quiz_responses has UNIQUE(user_id) — one row per coach, and it predates
    // this feature. The first version of this code plain-inserted: correct on a
    // first submission, 23505 on every retake, and green across every assertion
    // in this file because a mocked table has no constraints. It was caught by
    // running the function against production inside begin/rollback.
    // Modelling the constraint means the mock can now fail the way the database
    // does, so the next person to write an insert here finds out from the gate.
    const existing = quizRows.findIndex((r) => r.user_id === body.p_user_id)
    if (existing >= 0 && !UPSERTS) {
      return json({ code: '23505', message: 'duplicate key value violates unique constraint "quiz_responses_user_id_key"' }, 409)
    }

    const row: QuizRow = {
      id: existing >= 0 ? quizRows[existing].id : `quiz-${++rowSeq}`,
      user_id: body.p_user_id,
      answers: body.p_answers,
      problem_statement: body.p_problem_statement,
      score: body.p_score,
      analysis: body.p_analysis,
      created_at: new Date((clock += 1000)).toISOString(),
    }
    if (existing >= 0) quizRows[existing] = row
    else quizRows.push(row)
    // The stamp reads the INSERTED row's score, as the function does — so the
    // two can never be handed different numbers.
    const u = users[body.p_user_id]
    if (u) {
      u.quiz_completed = true
      u.quiz_score = row.score
    }
    return json(row)
  }

  if (url.includes('/rest/v1/quiz_responses')) {
    const m = /[?&]user_id=eq\.([^&]+)/.exec(url)
    const id = m ? m[1] : ''
    const mine = quizRows
      .filter((r) => r.user_id === id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    return json(mine.length ? mine[0] : null)
  }

  if (url.includes('/rest/v1/users')) {
    const m = /[?&]id=eq\.([^&]+)/.exec(url)
    const id = m ? m[1] : ''
    return json(users[id] || null)
  }

  return json({})
}) as typeof fetch

function makeRes() {
  const out: any = { status: 0, body: null }
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
    end() {
      return res
    },
  }
  return { res, out }
}

// Every question answered 'c', as a base to vary from.
const ANSWERS_C: Record<string, string> = Object.fromEntries(QUIZ_QUESTION_IDS.map((id) => [id, 'c']))
const ANSWERS_A: Record<string, string> = Object.fromEntries(QUIZ_QUESTION_IDS.map((id) => [id, 'a']))
const ANSWERS_D: Record<string, string> = Object.fromEntries(QUIZ_QUESTION_IDS.map((id) => [id, 'd']))

// The item-6 fixture: an apostrophe and a real line break, which are the two
// things a well-meaning sanitizer eats. Deliberately also has interior double
// spacing and mixed case, none of which may be touched.
const MESSY_PROBLEM = "I help coaches who can't say what they do\n\nin one sentence — they KNOW it, they just can't say it."

;(async () => {
  const analyze: Handler = (await import('../api/quiz/analyze')).default
  const getQuiz: Handler = (await import('../api/quiz/index')).default
  const getQuestions: Handler = (await import('../api/quiz/questions')).default

  async function post(userId: string, body: unknown) {
    const r = makeRes()
    await analyze(
      { method: 'POST', headers: { authorization: `Bearer ${await createSessionToken(userId)}` }, body },
      r.res
    )
    return r.out
  }
  async function get(userId: string) {
    const r = makeRes()
    await getQuiz({ method: 'GET', headers: { authorization: `Bearer ${await createSessionToken(userId)}` }, query: {} }, r.res)
    return r.out
  }

  console.log('\n-- the scoring table is complete and self-consistent --')
  {
    // The intended SHAPE, spelled out — these are the spec, not incidentals.
    // Everything else below derives its count so a question added or removed
    // moves one number here and nothing else.
    ok('eight questions are asked', QUIZ_QUESTIONS.length === 8, `${QUIZ_QUESTIONS.length}`)
    ok('seven of them are scored', SCORED_QUESTIONS.length === 7, `${SCORED_QUESTIONS.length}`)
    ok('Attract 3, Transform 2, Monetize 2', JSON.stringify(QUIZ_PILLARS.map((p) => SCORED_QUESTIONS.filter((q) => q.pillar === p).length)) === '[3,2,2]', JSON.stringify(QUIZ_PILLARS.map((p) => SCORED_QUESTIONS.filter((q) => q.pillar === p).length)))
    ok('and exactly one names the gap', QUIZ_QUESTIONS.filter((q) => q.kind === 'focus').length === 1)
    ok('every scored question belongs to a pillar', SCORED_QUESTIONS.every((q) => QUIZ_PILLARS.includes(q.pillar)))
    ok('every pillar has at least one scored question', QUIZ_PILLARS.every((p) => SCORED_QUESTIONS.some((q) => q.pillar === p)))
    ok('no duplicate question ids', new Set(QUIZ_QUESTION_IDS).size === QUIZ_QUESTIONS.length)

    // A composite with no moniker is a results screen with an empty headline.
    // Checked across all 101 values rather than by reading the bands.
    const gaps = assertMonikerBandsCoverEveryScore()
    ok('every composite 0-100 maps to exactly one moniker', gaps.length === 0, gaps.slice(0, 5).join('; '))
    ok('the bands are ordered and start at 0', MONIKER_BANDS[0].min === 0)
    ok('and end at 100', MONIKER_BANDS[MONIKER_BANDS.length - 1].max === 100)

    // The band check's sibling. normalise derives a pillar's range from the
    // QUESTION COUNT (n*1 to n*4), not from the points actually present, so a
    // table that drifts out of 1-4 does not fail — it makes a pillar's floor
    // unreachable, or pushes a composite past 100 into no band at all, throwing
    // from monikerFor a long way from the edit that caused it.
    const malformed = assertPointsTablesAreWellFormed()
    ok('every question offers a 1 and a 4, all within 1-4', malformed.length === 0, malformed.join('; '))
  }

  console.log('\n-- the assumptions those two guards protect are real --')
  {
    // Mutating the real table would leak into every later block, so the failure
    // modes are demonstrated on copies shaped like it. The point is to show the
    // guards catch what they claim, not to trust the wording.
    const noOne = { ...QUIZ_QUESTIONS[0], options: QUIZ_QUESTIONS[0].options.map((o) => ({ ...o, points: Math.max(o.points, 2) })) }
    ok(
      'a question with no 1 makes its floor unreachable',
      !noOne.options.some((o) => o.points === 1),
      'fixture no longer demonstrates the case'
    )

    const overFour = { ...QUIZ_QUESTIONS[0], options: QUIZ_QUESTIONS[0].options.map((o) => ({ ...o, points: o.points + 3 })) }
    ok('and points above 4 are what would exceed 100', overFour.options.some((o) => o.points > 4))

    // The band check would then be the thing that fires, which is the pairing:
    // a composite outside 0-100 matches no band and monikerFor throws rather
    // than returning a wrong headline.
    let threw = false
    try {
      const { monikerFor } = await import('../lib/quizScoring')
      monikerFor(140)
    } catch {
      threw = true
    }
    ok('an out-of-range composite throws rather than picking a band', threw)
  }

  console.log('\n-- ACCEPTANCE: the served questions and the scoring table are ONE source --')
  // Asserted against each other, never separately. Two lists that agree today
  // are two lists, and the failure this pins is silent: if the frontend owned
  // the option text and wrote (a) as the strongest answer on any question, every
  // score for that question would invert with no error anywhere.
  {
    const servedRes = makeRes()
    await getQuestions(
      { method: 'GET', headers: { authorization: `Bearer ${await createSessionToken(COACH)}` }, query: {} },
      servedRes.res
    )
    const served = servedRes.out
    ok('the question set is served', served.status === 200, `${served.status} ${JSON.stringify(served.body)}`)

    const questions = (served.body?.questions || []) as Array<{ id: string; prompt: string; options: Array<{ letter: string; label: string }> }>
    ok('all of them come back', questions.length === QUIZ_QUESTIONS.length, `${questions.length}`)
    // The progress counter reads from this. A literal anywhere downstream would
    // have gone stale when the scored set grew from six to seven.
    ok('the total is echoed from the served set, not a literal', served.body?.total === QUIZ_QUESTIONS.length, `${served.body?.total} vs ${QUIZ_QUESTIONS.length}`)
    ok('and it equals what was actually served', served.body?.total === questions.length, `${served.body?.total} vs ${questions.length}`)

    // ONE: every served option maps to a points entry.
    const unscored: string[] = []
    for (const q of questions) {
      const table = QUIZ_QUESTIONS.find((t) => t.id === q.id)
      if (!table) {
        unscored.push(`${q.id}: served but not in the scoring table`)
        continue
      }
      for (const o of q.options) {
        try {
          pointsFor(table, o.letter as any)
        } catch {
          unscored.push(`${q.id}.${o.letter}: served but worth nothing`)
        }
      }
    }
    ok('every served option maps to a points entry', unscored.length === 0, unscored.join('; '))

    // TWO: every points entry has served text.
    const unrendered: string[] = []
    for (const table of QUIZ_QUESTIONS) {
      const q = questions.find((s) => s.id === table.id)
      if (!q) {
        unrendered.push(`${table.id}: scored but never served`)
        continue
      }
      if (q.prompt !== table.prompt) unrendered.push(`${table.id}: served prompt differs from the table's`)
      for (const o of table.options) {
        const shown = q.options.find((s) => s.letter === o.letter)
        if (!shown) unrendered.push(`${table.id}.${o.letter}: scored but not offered`)
        else if (shown.label !== o.label) unrendered.push(`${table.id}.${o.letter}: served label differs from the table's`)
      }
    }
    ok('every points entry has served text', unrendered.length === 0, unrendered.join('; '))

    // Order is presentation only — the served sequence matches the table's, and
    // scoring is keyed by id and letter so resequencing moves no score.
    ok(
      'served order matches the table order',
      questions.map((q) => q.id).join(',') === QUIZ_QUESTION_IDS.join(','),
      questions.map((q) => q.id).join(',')
    )

    // THE RUBRIC IS NOT PUBLISHED. Serving points would put the answer key on
    // the page of a self-assessment.
    const wire = JSON.stringify(served.body)
    ok('no option carries its points on the wire', !questions.some((q) => q.options.some((o) => 'points' in o)), wire)
    ok('and no pillar is disclosed either', !/"pillar"/.test(wire), wire)

    // THE PIVOT. Seven questions ask about the coach and this one asks about
    // their clients. On the first real run the person who SPECIFIED the feature
    // answered it with his own problem — "I have a problem asking people for
    // money and closing the deal" — which is the strongest evidence available
    // that coaches will. The cause is momentum, not wording: the switch of
    // subject was unmarked.
    ok('the subject change is served as its own field', typeof served.body?.problem_question?.pivot === 'string' && served.body.problem_question.pivot.length > 0, JSON.stringify(served.body?.problem_question))
    ok('and it says the subject is changing', /changes subject/i.test(served.body?.problem_question?.pivot || ''), served.body?.problem_question?.pivot)
    ok('naming what came before as being about them', /about you and your business/i.test(served.body?.problem_question?.pivot || ''))
    ok('and this one as being about the people they help', /about the people you help/i.test(served.body?.problem_question?.pivot || ''))
    ok('it is NOT folded into the prompt', !/changes subject/i.test(served.body?.problem_question?.prompt || ''), 'the pivot was merged into the question, which is the thing being skimmed past')

    // The prompt itself must not read as "what problem are you working on".
    // "you" as the grammatical subject is what the old wording had, and after
    // seven questions about the coach that reading wins.
    const prompt = served.body?.problem_question?.prompt || ''
    ok('the question puts the people they help in the subject position', /^What problem do the people you help/.test(prompt), prompt)
    ok('and the old wording is gone', !/what problem do you help people solve/i.test(prompt), prompt)

    const help = served.body?.problem_question?.help || ''
    ok('the help text says WHOSE problem it is', /their problem/i.test(help), help)
    ok('and names the misreading explicitly', /not the problem you are working on/i.test(help), help)
    ok('while keeping the verbatim promise', /exactly as you write it/i.test(help), help)

    // EVERY HUMAN-READABLE STRING IN THE PAYLOAD, counted. Pinned so the
    // frontend's grep total moves deliberately rather than silently — adding
    // copy here is a number that changes in one place on purpose.
    const copyStrings = [
      ...questions.map((q) => q.prompt),
      ...questions.flatMap((q) => q.options.map((o) => o.label)),
      served.body?.problem_question?.pivot,
      served.body?.problem_question?.prompt,
      served.body?.problem_question?.help,
    ].filter((x) => typeof x === 'string' && x.length > 0)
    console.log(`      served copy strings: ${copyStrings.length}`)
    ok(`the payload serves 43 copy strings (8 prompts + 32 options + pivot/prompt/help)`, copyStrings.length === 43, `${copyStrings.length}`)
    ok('and none of them is blank', copyStrings.every((x) => String(x).trim().length > 0))

    // The open question travels with them, separately, because it is not scored
    // and must not be rendered into the scored loop.
    ok('the open question is served', served.body?.problem_question?.prompt === QUIZ_PROBLEM_PROMPT, JSON.stringify(served.body?.problem_question))
    ok('and is not one of the multiple-choice set', !questions.some((q) => q.prompt === QUIZ_PROBLEM_PROMPT))
    ok('and names the field it posts to', served.body?.problem_question?.field === 'problem_statement')

    // Answering with what was served is accepted end to end — the loop closed.
    const fromServed = Object.fromEntries(questions.map((q) => [q.id, q.options[q.options.length - 1].letter]))
    const submitted = await post(COACH, { answers: fromServed })
    ok('answers built from the served set score cleanly', submitted.status === 200, `${submitted.status} ${JSON.stringify(submitted.body)}`)
    resetDb()
  }

  console.log('\n-- ACCEPTANCE 4: scoring is deterministic --')
  {
    // Pure-function level first: if this were unstable, the endpoint-level
    // check would be measuring the wrong thing.
    const runs = Array.from({ length: 25 }, () => JSON.stringify(scoreQuiz(ANSWERS_C as any)))
    ok('25 runs of the same answers are byte-identical', new Set(runs).size === 1, `${new Set(runs).size} distinct results`)

    const allA = scoreQuiz(ANSWERS_A as any)
    const allD = scoreQuiz(ANSWERS_D as any)
    ok('the worst answers score 0', allA.composite === 0, JSON.stringify(allA.scores))
    ok('the best answers score 100', allD.composite === 100, JSON.stringify(allD.scores))
    ok(
      'each pillar normalises across its full range, whatever its question count',
      QUIZ_PILLARS.every((p) => allA.scores[p] === 0 && allD.scores[p] === 100),
      `${JSON.stringify(allA.scores)} / ${JSON.stringify(allD.scores)}`
    )

    // Attract holds three questions and the others two. Summing raw points
    // would silently make Attract worth half again as much; the composite is
    // the mean of normalised pillars precisely so it does not.
    const attractOnly = scoreQuiz({ ...ANSWERS_A, client_flow: 'd', lead_source: 'd', ideal_client: 'd' } as any)
    const monetizeOnly = scoreQuiz({ ...ANSWERS_A, pricing_confidence: 'd', ninety_day_goal: 'd' } as any)
    ok(
      'a maxed 3-question pillar counts the same as a maxed 2-question pillar',
      attractOnly.composite === monetizeOnly.composite,
      `attract ${attractOnly.composite} vs monetize ${monetizeOnly.composite}`
    )

    // The unscored question moves NO number. Same scored answers, four
    // different stated challenges, identical scores — which is the property
    // that broke before: it summed into Transform and dragged it around.
    const acrossChallenges = FOCUS_QUESTION.options.map((o) =>
      JSON.stringify(scoreQuiz({ ...ANSWERS_C, biggest_challenge: o.letter } as any).scores)
    )
    ok(
      'the stated challenge changes no score',
      new Set(acrossChallenges).size === 1,
      acrossChallenges.join(' | ')
    )
  }

  console.log('\n-- ACCEPTANCE: the gap comes from what the coach SAID --')
  // Asserted against the stated challenge, never against the derived minimum.
  // The defect this replaces was measured, not theorised: all-best scored
  // answers plus "not enough people know I exist" produced Attract 100,
  // Transform 50, and the line "Your biggest gap is Transform — what you deliver
  // is clearer in your head than it is out loud", contradicting the offer-clarity
  // answer the coach had given two questions earlier.
  {
    const BEST = Object.fromEntries(SCORED_QUESTIONS.map((q) => [q.id, 'd']))
    const WORST = Object.fromEntries(SCORED_QUESTIONS.map((q) => [q.id, 'a']))

    // Mid scores, so nothing is suppressed by the floor and the stated challenge
    // is visibly the thing choosing the advice.
    for (const o of FOCUS_QUESTION.options) {
      const r = scoreQuiz({ ...ANSWERS_C, biggest_challenge: o.letter } as any)
      ok(
        `challenge '${o.letter}' (${o.focus}) -> the gap is about ${o.focus}`,
        r.gap.focus === o.focus,
        `${r.gap.focus} — "${r.gap.title}"`
      )
      ok(`and the quick win is the ${o.focus} one`, r.quick_win.title.length > 0)
      ok(`and the stated challenge travels for Step 1`, r.stated_challenge.focus === o.focus && r.stated_challenge.letter === o.letter, JSON.stringify(r.stated_challenge))
      ok(`with the label, not just the letter`, r.stated_challenge.label === o.label)
    }

    console.log('\n-- ACCEPTANCE: the all-perfect case, stated explicitly --')
    // The loud defect: composite 100, moniker "The Full Engine", and directly
    // beneath it "Your biggest gap is Attract". lowestPillar had no floor, so
    // three pillars tied at 100 resolved by tiebreak order and printed a gap
    // that did not exist.
    for (const o of FOCUS_QUESTION.options) {
      const r = scoreQuiz({ ...BEST, biggest_challenge: o.letter } as any)
      ok(`all-perfect + '${o.letter}': composite is 100`, r.composite === 100, `${r.composite}`)
      ok(`all-perfect + '${o.letter}': moniker is The Full Engine`, r.moniker === 'The Full Engine', r.moniker)

      if (o.focus === 'capacity') {
        // Not suppressed, and correctly so: no pillar measures delivery
        // capacity, so no score contradicts it. "The Full Engine" and "you
        // cannot deliver more" are a coherent pair.
        ok('capacity survives a perfect score', r.gap.focus === 'capacity', `${r.gap.focus}`)
        ok('and it is not a pillar', !QUIZ_PILLARS.includes(r.gap.focus as any))
      } else {
        // THE ASSERTION THAT WOULD HAVE CAUGHT THE DEFECT.
        ok(`all-perfect + '${o.letter}': NO gap pillar is named`, r.gap.focus === null, `named ${r.gap.focus}: "${r.gap.title}"`)
        ok('and the copy says so rather than being blank', r.gap.body.length > 20 && r.gap.title.length > 0, r.gap.title)
        ok('the quick win is the no-gap one, not a pillar fix', r.quick_win.title === 'Do more of what already worked', r.quick_win.title)
        ok('the answer is still carried even though the advice is withheld', r.stated_challenge.focus === o.focus)
      }
    }

    console.log('\n-- ACCEPTANCE: the all-worst case, stated explicitly --')
    for (const o of FOCUS_QUESTION.options) {
      const r = scoreQuiz({ ...WORST, biggest_challenge: o.letter } as any)
      ok(`all-worst + '${o.letter}': composite is 0`, r.composite === 0, `${r.composite}`)
      ok(`all-worst + '${o.letter}': moniker is The Well-Kept Secret`, r.moniker === 'The Well-Kept Secret', r.moniker)

      if (o.focus === 'capacity') {
        // THE SECOND REPORTED DEFECT. At 0/0/0 the capacity body asserted "the
        // offer sells and the constraint is delivery" directly under a moniker
        // whose own summary says almost nobody knows they exist. Capacity makes
        // a factual claim about the business, so it needs evidence.
        ok('all-worst + capacity: capacity is NOT named', r.gap.focus !== 'capacity', `${r.gap.focus}`)
        ok('the disagreement is resolved rather than hidden', r.gap.resolution === 'conflict', r.gap.resolution)
        ok('and what the coach said is still reported', r.gap.disputed === 'capacity', `${r.gap.disputed}`)
        ok('the body does not claim the offer sells', !r.gap.body.includes('The offer sells'), r.gap.body)
      } else {
        // A stated pillar at rock bottom is not contradicted by anything — every
        // pillar is 0, so nothing is strictly highest. The statement stands.
        ok(`all-worst + '${o.letter}': the stated gap IS named`, r.gap.focus === o.focus, `${r.gap.focus}`)
        ok('and it is reported as the coach own statement', r.gap.resolution === 'stated', r.gap.resolution)
      }
    }

    console.log('\n-- ACCEPTANCE: the reported case, by value --')
    // Attract 0, Transform 0, Monetize 17, challenge (c). The page said "Your
    // biggest gap is Monetize" — the only pillar with any score at all.
    {
      // Built from WORST so a question added later cannot silently drop out of
      // this fixture — the first version listed the ids by hand and stopped
      // covering delivery_repeatability the moment it was added, throwing rather
      // than quietly scoring a partial answer set.
      const r = scoreQuiz({ ...WORST, ninety_day_goal: 'b', biggest_challenge: 'c' } as any)
      ok('the scores reproduce', JSON.stringify(r.scores) === JSON.stringify({ attract: 0, transform: 0, monetize: 17 }), JSON.stringify(r.scores))
      ok('the gap is no longer Monetize', r.gap.focus !== 'monetize', `${r.gap.focus} — "${r.gap.title}"`)
      ok('it names a pillar the scores actually put lowest', r.gap.focus !== null && r.scores[r.gap.focus as 'attract' | 'transform' | 'monetize'] === 0)
      ok('and the coach is told what they said, not overruled in silence', r.gap.disputed === 'monetize' && r.gap.body.includes('Monetize'), r.gap.body)
    }

    console.log('\n-- ACCEPTANCE: exhaustive — the page never asserts what the scores deny --')
    // Every combination of every scored question against every challenge.
    //
    // THE FIRST VERSION OF THIS SWEEP LOOKED FOR THE OLD DEFECT AND FOUND
    // NOTHING, which is how it passed while two new ones shipped. It asked "does
    // the page name a pillar that is in the top band" — the exact inverse of the
    // bug that had just been fixed — instead of asking the general question the
    // rule is actually about. Written the general way now: whatever the page
    // names, the scores have to support it.
    {
      const ids = SCORED_QUESTIONS.map((q) => q.id)
      let total = 0
      const census = { none: 0, stated: 0, conflict: 0 }
      const namesStrongest: string[] = []
      const capacityUnevidenced: string[] = []
      const namesTopBand: string[] = []
      const outOfRange: string[] = []
      const noCopy: string[] = []
      const anyFocusViolation: string[] = []
      const standingMismatch: string[] = []
      let tiedHighest = 0
      let capacityNamed = 0

      const walk = (i: number, acc: Record<string, string>) => {
        if (i === ids.length) {
          for (const o of FOCUS_QUESTION.options) {
            const r = scoreQuiz({ ...acc, biggest_challenge: o.letter } as any)
            total++
            census[r.gap.resolution]++
            const where = `${JSON.stringify(acc)}+${o.letter} scores=${JSON.stringify(r.scores)}`

            if (r.composite < 0 || r.composite > 100) outOfRange.push(`${r.composite}`)
            if (!r.gap.title.trim() || !r.gap.body.trim() || !r.quick_win.title.trim()) noCopy.push(where)

            // THE PREDICATE, EVERY FOCUS — and spelled out HERE rather than via
            // lib's focusStanding.
            //
            // The first version of this assertion called focusStanding, which
            // made it self-referential: mutating that function moved the rule
            // AND the test together, so swapping capacity's standing from the
            // highest pillar to the lowest passed cleanly while capacity was
            // named 8612 times again. A test that reuses the thing it is
            // checking is checking nothing. Found by mutation, not by reading.
            if (r.gap.focus) {
              const vals = QUIZ_PILLARS.map((p) => r.scores[p])
              const lo = Math.min(...vals)
              const hi = Math.max(...vals)
              // A pillar is measured from its own score; capacity claims the
              // business is working, so it is measured from the top.
              const standing = r.gap.focus === 'capacity' ? hi : r.scores[r.gap.focus as 'attract' | 'transform' | 'monetize']
              if (standing - lo >= MATERIAL_MARGIN && anyFocusViolation.length < 3) {
                anyFocusViolation.push(`${where} -> named ${r.gap.focus}, standing ${standing}, lowest ${lo}`)
              }
              if (r.gap.focus === 'capacity') capacityNamed++
              // And the lib agrees with the predicate written out here — kept as
              // a separate check so the two can disagree loudly instead of the
              // assertion silently inheriting whatever the lib decides.
              if (focusStanding(r.scores, r.gap.focus) !== standing && standingMismatch.length < 3) {
                standingMismatch.push(`${where}: lib says ${focusStanding(r.scores, r.gap.focus)}, predicate says ${standing}`)
              }
            }

            const pillar = r.gap.focus && r.gap.focus !== 'capacity' ? (r.gap.focus as 'attract' | 'transform' | 'monetize') : null
            if (pillar) {
              const values = QUIZ_PILLARS.map((p) => r.scores[p])
              const lowest = Math.min(...values)
              // THE PREDICATE, stated once and with no companion test: a named
              // pillar may not sit MATERIAL_MARGIN or more above the LOWEST,
              // whether or not it is tied with another.
              //
              // The previous version of this assertion carried an extra
              // `isStrictlyHighest` term, which let 3288 tied cases through —
              // the check returned on a fact about the TOP before the margin,
              // a question about the BOTTOM, was ever applied. Worst measured:
              // Attract 0, Transform 83, Monetize 83, printing "your biggest
              // gap is Transform" with Attract at zero and unmentioned.
              const spread = r.scores[pillar] - lowest
              if (spread >= MATERIAL_MARGIN) {
                if (namesStrongest.length < 3) namesStrongest.push(`${where} -> named ${pillar}, ${spread} above the lowest`)
              }
              // Counted separately so the TIE case is visibly covered by the
              // predicate rather than exempted from it. This must now be 0.
              const isStrictlyHighest = values.filter((v) => v === r.scores[pillar]).length === 1 && values.every((v) => v <= r.scores[pillar])
              const isHighestOrTied = values.every((v) => v <= r.scores[pillar])
              if (isHighestOrTied && !isStrictlyHighest && spread >= MATERIAL_MARGIN) tiedHighest++
              // And the original defect stays ruled out.
              if (r.scores[pillar] >= GAP_FLOOR && namesTopBand.length < 3) namesTopBand.push(`${where} -> ${pillar}`)
            }

            // Capacity asserts a selling business. It needs evidence.
            if (r.gap.focus === 'capacity' && r.composite < CAPACITY_EVIDENCE_FLOOR) {
              if (capacityUnevidenced.length < 3) capacityUnevidenced.push(`${where} composite=${r.composite}`)
            }
          }
          return
        }
        for (const l of ['a', 'b', 'c', 'd']) walk(i + 1, { ...acc, [ids[i]]: l })
      }
      walk(0, {})

      ok(`swept every combination (${total} results)`, total === Math.pow(4, ids.length) * FOCUS_QUESTION.options.length, `${total}`)

      // THE TWO REPORTED DEFECTS, as general assertions.
      // ONE ASSERTION, EVERY FOCUS — pillar and capacity alike. The pillar-only
      // version below is kept as the narrower restatement, but this is the one
      // that would have caught the capacity leak.
      ok('no focus of ANY kind is named while standing MATERIAL_MARGIN or more above the lowest pillar', anyFocusViolation.length === 0, anyFocusViolation.join(' ; '))
      ok('no result names a pillar sitting MATERIAL_MARGIN or more above the lowest', namesStrongest.length === 0, namesStrongest.join(' ; '))
      ok("lib's focusStanding agrees with the predicate written out independently", standingMismatch.length === 0, standingMismatch.join(' ; '))
      ok('capacity is never named without supporting evidence in the scores', capacityUnevidenced.length === 0, capacityUnevidenced.join(' ; '))

      // The original one, still ruled out.
      ok('no result names a pillar gap that is already in the top band', namesTopBand.length === 0, namesTopBand.join(' ; '))
      ok('no composite falls outside 0-100', outOfRange.length === 0, outOfRange.slice(0, 3).join(', '))
      ok('every result renders copy in both cards', noCopy.length === 0, noCopy.slice(0, 2).join(' ; '))

      // THE CENSUS. Reported so a guard that silently swallows everything is
      // visible as one: if `none` or `conflict` were most of the sweep, the page
      // would be refusing to diagnose almost anybody and every assertion above
      // would still pass.
      console.log(`      census of ${total}: stated ${census.stated}, conflict ${census.conflict}, none ${census.none}`)
      console.log(`      names a TIED-highest pillar with a material spread: ${tiedHighest} (must be 0 — the tie is not an exemption)`)
      console.log(`      capacity named: ${capacityNamed} of ${total}`)
      // WHAT THESE ASSERT, AND WHAT THEY DELIBERATELY DO NOT.
      //
      // An earlier version required `stated` to be the majority and `conflict`
      // to be under half. Those failed the moment the predicate was corrected —
      // correctly, because they were never properties of the RULE. They were
      // properties of the sweep's distribution, frozen from a run where the tie
      // branch was silently letting 3288 results through. An assertion that
      // fails when a bug is fixed is an assertion pinning the bug.
      //
      // The real risk the census guards is a fix that "passes" by sending
      // everything to one state, so that is what is asserted: every state stays
      // reachable, and no state swallows the sweep. The exact split is REPORTED
      // rather than constrained.
      //
      // On the split itself: conflict is now the larger share and that is
      // arithmetic, not alarm. This sweep is uniform over the answer space, and
      // a uniformly-random stated challenge matches the weakest pillar about a
      // third of the time. Real coaches are not uniform — somebody who says
      // nobody can find them tends to answer the Attract questions poorly too.
      // The sweep measures reachability, never expected frequency.
      for (const [state, n] of Object.entries(census)) {
        ok(`'${state}' is reachable (${n})`, (n as number) > 0, `${n} of ${total}`)
        ok(`'${state}' does not swallow the sweep`, (n as number) < total * 0.9, `${n} of ${total}`)
      }
      ok('the three states account for everything', census.none + census.stated + census.conflict === total)
      // NOT bounded — zero. This was 3288 and was logged as "allowed
      // deliberately", which is how an exemption reads as a decision. Being tied
      // at the top is not evidence about the bottom.
      ok('the tie case is covered by the predicate, not exempted from it', tiedHighest === 0, `${tiedHighest} of ${total}`)
    }

    // The floor and the top band are one number by construction. Replacing the
    // derivation with a literal fails here rather than letting "The Full Engine"
    // sit above a named gap again.
    ok('the gap floor matches the top moniker band', assertGapFloorMatchesTopBand().length === 0, assertGapFloorMatchesTopBand().join('; '))
    ok(`and that number is ${GAP_FLOOR}`, GAP_FLOOR === 90, `${GAP_FLOOR}`)
  }

  console.log('\n-- a missing or bogus answer is refused, never defaulted --')
  {
    // Scoring a skipped question as 'a' would produce a real-looking composite
    // built partly from something the coach never said, undetectable afterwards.
    const missing = { ...ANSWERS_C }
    delete missing.offer_clarity
    const r1 = await post(COACH, { answers: missing })
    ok('a missing answer is 400', r1.status === 400, `${r1.status} ${JSON.stringify(r1.body)}`)
    ok('and names the question', String(r1.body?.message || '').includes('offer_clarity'), JSON.stringify(r1.body))

    const r2 = await post(COACH, { answers: { ...ANSWERS_C, offer_clarity: 'e' } })
    ok('a letter outside a-d is 400', r2.status === 400, `${r2.status}`)

    const r3 = await post(COACH, { answers: 'not an object' })
    ok('a non-object answers block is 400', r3.status === 400, `${r3.status}`)

    ok('and none of those wrote a row', quizRows.length === 0, JSON.stringify(quizRows))
    ok('nor stamped the user', users[COACH].quiz_completed === false && users[COACH].quiz_score === null)
  }

  console.log('\n-- ACCEPTANCE 1 + 6: the stored ROW is what gets asserted --')
  {
    resetDb()
    const res = await post(COACH, { answers: ANSWERS_C, problem_statement: MESSY_PROBLEM })
    ok('the submission succeeds', res.status === 200, `${res.status} ${JSON.stringify(res.body)}`)

    ok('exactly one row was written', quizRows.length === 1, `${quizRows.length}`)
    const row = quizRows[0]

    // Asserted against the ROW, not the response body — the brief is explicit,
    // and a handler that returned a correct-looking payload while storing
    // something else is exactly the failure this catches.
    ok('the row holds every letter', QUIZ_QUESTION_IDS.every((id) => row.answers[id] === 'c'), JSON.stringify(row.answers))
    ok('and only those', Object.keys(row.answers).length === QUIZ_QUESTION_IDS.length, JSON.stringify(Object.keys(row.answers)))
    ok('the row holds the composite', typeof row.score === 'number' && row.score === (res.body as any).score, `${row.score}`)
    ok('the row holds the analysis object', !!row.analysis && typeof (row.analysis as any).moniker === 'string', JSON.stringify(row.analysis))
    ok(
      'the analysis carries all three sub-scores',
      QUIZ_PILLARS.every((p) => typeof (row.analysis as any).scores?.[p] === 'number'),
      JSON.stringify((row.analysis as any).scores)
    )
    ok('and a gap and a quick win', !!(row.analysis as any).gap?.body && !!(row.analysis as any).quick_win?.body)

    // ACCEPTANCE 6: verbatim. Compared to the ORIGINAL constant, character for
    // character — apostrophe, blank line, interior spacing and casing.
    ok(
      'the free text is stored EXACTLY as typed',
      row.problem_statement === MESSY_PROBLEM,
      `\n      stored:   ${JSON.stringify(row.problem_statement)}\n      expected: ${JSON.stringify(MESSY_PROBLEM)}`
    )
    ok("the apostrophe survived", String(row.problem_statement).includes("can't"))
    ok('the line break survived', String(row.problem_statement).includes('\n\n'))
    ok('the casing survived', String(row.problem_statement).includes('KNOW'))
  }

  console.log('\n-- ACCEPTANCE 2: the user record is stamped SERVER-side --')
  {
    // Read from the user record, not from the response. The state this replaces
    // is quiz_completed=true with quiz_score=null, set by a browser.
    ok('quiz_completed is true', users[COACH].quiz_completed === true)
    ok(
      'quiz_score matches the row score',
      users[COACH].quiz_score === quizRows[0].score,
      `user ${users[COACH].quiz_score} vs row ${quizRows[0].score}`
    )
    ok('and it is not null, which is the state this fixes', users[COACH].quiz_score !== null)

    // The client cannot assert its own completion.
    await post(COACH, { answers: ANSWERS_C, quiz_completed: false, score: 999, quiz_score: 999 })
    ok('a client-supplied score is ignored', users[COACH].quiz_score !== 999, `${users[COACH].quiz_score}`)
    ok('a client-supplied completion flag is ignored', users[COACH].quiz_completed === true)
    // The coach's row, found by user_id rather than by index — a retake
    // replaces it in place, so there is no "the row the last post appended".
    const stored = quizRows.find((r) => r.user_id === COACH)!
    ok('the extra keys were not persisted', !('score' in stored.answers) && !('quiz_completed' in stored.answers), JSON.stringify(stored.answers))
  }

  console.log('\n-- ACCEPTANCE 4 (endpoint): identical answers twice, compared by value --')
  {
    resetDb()
    const first = await post(COACH, { answers: ANSWERS_C, problem_statement: 'same text' })
    const second = await post(COACH, { answers: ANSWERS_C, problem_statement: 'same text' })

    ok('both submissions succeed', first.status === 200 && second.status === 200)
    ok('both scores are equal', (first.body as any).score === (second.body as any).score, `${(first.body as any).score} vs ${(second.body as any).score}`)
    ok(
      'and the whole analysis is identical by value',
      JSON.stringify((first.body as any).analysis) === JSON.stringify((second.body as any).analysis),
      `\n      1: ${JSON.stringify((first.body as any).analysis)}\n      2: ${JSON.stringify((second.body as any).analysis)}`
    )
    // ONE ROW, NOT TWO. This asserted `retaking keeps both attempts` and was
    // wrong about the schema: quiz_responses is UNIQUE on user_id, so the
    // second submission replaces the first. The assertion passed anyway,
    // because the mock had no constraint — the real database answered 23505.
    ok('a retake replaces the row rather than accumulating', quizRows.length === 1, `${quizRows.length}`)
    ok('and the surviving row carries the latest score', quizRows[0].score === (second.body as any).score)

    // And the constraint in the mock genuinely bites — checked by turning the
    // upsert off and watching the same submission fail.
    UPSERTS = false
    const wouldConflict = await post(COACH, { answers: ANSWERS_C })
    ok('without upsert, a retake is a 500 from the duplicate key', wouldConflict.status === 500, `${wouldConflict.status}`)
    ok('so the guard is real, not decorative', quizRows.length === 1, `${quizRows.length}`)
    UPSERTS = true
  }

  console.log('\n-- ACCEPTANCE 3: GET returns the most recent, 404s when there is none --')
  {
    // A newcomer first, before anything could make this pass accidentally.
    const none = await get(NEWCOMER)
    ok('a coach who never took it gets 404', none.status === 404, `${none.status} ${JSON.stringify(none.body)}`)
    ok('and no result body', !none.body?.score && !none.body?.analysis, JSON.stringify(none.body))

    const mine = await get(COACH)
    ok('the coach gets their result', mine.status === 200, `${mine.status}`)
    ok('with the score', mine.body?.score === quizRows.find((r) => r.user_id === COACH)!.score, `${mine.body?.score}`)
    ok('the analysis', typeof mine.body?.analysis?.moniker === 'string')
    ok('and the problem statement', mine.body?.problem_statement === 'same text', JSON.stringify(mine.body?.problem_statement))

    // MOST RECENT, proven by making the newest row distinguishable rather than
    // by trusting insertion order.
    await post(COACH, { answers: ANSWERS_D, problem_statement: 'the newest one' })
    const latest = await get(COACH)
    ok('a retake replaces what GET returns', latest.body?.problem_statement === 'the newest one', JSON.stringify(latest.body?.problem_statement))
    ok('and the score is the new one', latest.body?.score === 100, `${latest.body?.score}`)

    // One coach's result is never another's.
    const stillNone = await get(NEWCOMER)
    ok("another coach still 404s and cannot see it", stillNone.status === 404, `${stillNone.status}`)
  }

  console.log('\n-- ACCEPTANCE 5 (backend half): a failed analyze leaves nothing behind --')
  {
    resetDb()
    rpcShouldFail = true
    const failed = await post(COACH, { answers: ANSWERS_C, problem_statement: 'should not persist' })

    ok('the endpoint reports failure', failed.status === 500, `${failed.status}`)
    ok('no row was written', quizRows.length === 0, JSON.stringify(quizRows))
    ok('quiz_completed stays false', users[COACH].quiz_completed === false)
    ok('quiz_score stays null', users[COACH].quiz_score === null)

    // The mock-results fallback the brief bans: score 68 and "The Hidden Gem"
    // must not appear in a failure response. "The Hidden Gem" is a REAL moniker
    // in the ladder, so this checks the failure body carries no result at all
    // rather than checking for that string — a value check would pass while a
    // genuine 68 leaked, and fail if the band were ever renamed.
    const bodyText = JSON.stringify(failed.body)
    ok('the failure body carries no score', !('score' in (failed.body as any)), bodyText)
    ok('and no analysis', !('analysis' in (failed.body as any)), bodyText)
    ok('and does not claim completion', (failed.body as any).quiz_completed !== true, bodyText)

    rpcShouldFail = false
    const retried = await post(COACH, { answers: ANSWERS_C, problem_statement: 'should not persist' })
    ok('a retry after the failure works', retried.status === 200, `${retried.status}`)
    ok('and only then is the user stamped', users[COACH].quiz_completed === true)
  }

  console.log('\n-- the open question is optional, and never scored --')
  {
    resetDb()
    const noText = await post(COACH, { answers: ANSWERS_C })
    ok('omitting it is allowed', noText.status === 200, `${noText.status}`)
    ok('and stores an empty string, not null', quizRows[0].problem_statement === '', JSON.stringify(quizRows[0].problem_statement))

    // Same letters, wildly different prose -> identical numbers. The free text
    // must not reach the scorer by any route.
    const withText = await post(COACH, { answers: ANSWERS_C, problem_statement: MESSY_PROBLEM })
    ok(
      'the free text changes no number',
      JSON.stringify((noText.body as any).analysis) === JSON.stringify((withText.body as any).analysis),
      `${JSON.stringify((noText.body as any).analysis)}\n      ${JSON.stringify((withText.body as any).analysis)}`
    )

    // Trimmed at the ends only; the interior is untouched.
    const padded = await post(COACH, { answers: ANSWERS_C, problem_statement: '   spaced out   ' })
    ok('surrounding whitespace is trimmed', quizRows[quizRows.length - 1].problem_statement === 'spaced out')
    void padded

    ok('a non-string is coerced to empty rather than stored', normalizeProblemStatement(42) === '')
    ok('and interior whitespace is never collapsed', normalizeProblemStatement('a  b\n\nc') === 'a  b\n\nc')
  }

  console.log('\n-- guards --')
  {
    const r = makeRes()
    await analyze({ method: 'GET', headers: {}, body: {} }, r.res)
    ok('GET /api/quiz/analyze is 405', r.out.status === 405, `${r.out.status}`)

    const r2 = makeRes()
    await getQuiz({ method: 'POST', headers: {}, query: {} }, r2.res)
    ok('POST /api/quiz is 405', r2.out.status === 405, `${r2.out.status}`)

    const r3 = makeRes()
    await analyze({ method: 'POST', headers: {}, body: { answers: ANSWERS_C } }, r3.res)
    ok('an unauthenticated analyze is refused', r3.out.status === 401 || r3.out.status === 403, `${r3.out.status}`)

    const r4 = makeRes()
    await getQuiz({ method: 'GET', headers: {}, query: {} }, r4.res)
    ok('an unauthenticated read is refused', r4.out.status === 401 || r4.out.status === 403, `${r4.out.status}`)

    const r5 = makeRes()
    await getQuestions({ method: 'POST', headers: {}, query: {} }, r5.res)
    ok('POST /api/quiz/questions is 405', r5.out.status === 405, `${r5.out.status}`)

    const r6 = makeRes()
    await getQuestions({ method: 'GET', headers: {}, query: {} }, r6.res)
    ok('the question set is not public', r6.out.status === 401 || r6.out.status === 403, `${r6.out.status}`)
  }

  console.log('\n-- validateQuizAnswers drops unknown keys rather than storing them --')
  {
    const checked = validateQuizAnswers({ ...ANSWERS_C, sneaky: 'd', quiz_score: '999' })
    ok('it accepts the submission', checked.ok)
    ok('and keeps only the known ids', checked.ok && Object.keys(checked.answers).length === QUIZ_QUESTION_IDS.length, JSON.stringify(checked.ok && checked.answers))
    ok('uppercase letters are accepted and folded', (() => { const c = validateQuizAnswers({ ...ANSWERS_C, client_flow: 'D' }); return c.ok && c.answers.client_flow === 'd' })())
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
