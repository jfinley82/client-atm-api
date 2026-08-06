process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '../lib/auth'
import {
  MONIKER_BANDS,
  QUIZ_PILLARS,
  QUIZ_QUESTIONS,
  QUIZ_QUESTION_IDS,
  assertMonikerBandsCoverEveryScore,
  lowestPillar,
  normalizeProblemStatement,
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
    ok('seven scored questions', QUIZ_QUESTIONS.length === 7, `${QUIZ_QUESTIONS.length}`)
    ok('every question belongs to a pillar', QUIZ_QUESTIONS.every((q) => QUIZ_PILLARS.includes(q.pillar)))
    ok('every pillar has at least one question', QUIZ_PILLARS.every((p) => QUIZ_QUESTIONS.some((q) => q.pillar === p)))
    ok('no duplicate question ids', new Set(QUIZ_QUESTION_IDS).size === 7)
    ok(
      'every question scores all four letters within 1-4',
      QUIZ_QUESTIONS.every((q) => (['a', 'b', 'c', 'd'] as const).every((l) => q.points[l] >= 1 && q.points[l] <= 4))
    )

    // A composite with no moniker is a results screen with an empty headline.
    // Checked across all 101 values rather than by reading the bands.
    const gaps = assertMonikerBandsCoverEveryScore()
    ok('every composite 0-100 maps to exactly one moniker', gaps.length === 0, gaps.slice(0, 5).join('; '))
    ok('the bands are ordered and start at 0', MONIKER_BANDS[0].min === 0)
    ok('and end at 100', MONIKER_BANDS[MONIKER_BANDS.length - 1].max === 100)
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

    // A tie must resolve the same way every time, not by object key order.
    const tied = { attract: 50, transform: 50, monetize: 50 } as Record<any, number>
    ok('a three-way tie resolves stably', new Set(Array.from({ length: 10 }, () => lowestPillar(tied as any))).size === 1)
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
    ok('the row holds all seven letters', QUIZ_QUESTION_IDS.every((id) => row.answers[id] === 'c'), JSON.stringify(row.answers))
    ok('and only those seven', Object.keys(row.answers).length === 7, JSON.stringify(Object.keys(row.answers)))
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
  }

  console.log('\n-- validateQuizAnswers drops unknown keys rather than storing them --')
  {
    const checked = validateQuizAnswers({ ...ANSWERS_C, sneaky: 'd', quiz_score: '999' })
    ok('it accepts the submission', checked.ok)
    ok('and keeps only the known ids', checked.ok && Object.keys(checked.answers).length === 7, JSON.stringify(checked.ok && checked.answers))
    ok('uppercase letters are accepted and folded', (() => { const c = validateQuizAnswers({ ...ANSWERS_C, client_flow: 'D' }); return c.ok && c.answers.client_flow === 'd' })())
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
