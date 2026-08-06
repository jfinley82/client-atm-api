// The ATM Quiz: seven multiple-choice questions, three sub-scores, one composite.
//
// EVERYTHING THAT DECIDES A NUMBER IS A TABLE IN THIS FILE, and so is every word
// the coach reads. No points are computed in the handler, none are derived from
// the order options happen to appear in, and nothing reaches for the clock or a
// random seed. Same answers, same numbers, forever — which is the whole
// requirement: a coach who retakes the quiz and gets a different result for the
// same answers will not trust it, and neither will whoever is debugging it later.
//
// THE OPTION TEXT LIVES HERE WITH ITS POINTS, IN THE SAME OBJECT. An earlier
// version put points against bare letters and left the wording to the frontend,
// which protects against options being REORDERED and not at all against them
// MEANING something else. If the frontend had written option (a) on any question
// as the strongest answer, every score for that question would have inverted
// silently — no error, no failing test, just wrong numbers under a coach's name.
// Serving the text from here (see api/quiz/questions.ts) removes the second
// place the meaning could live. Same reason resolveBookingQuestions exists.
//
// The three pillars are the method's own: Attract (can people find you and do
// you know who they are), Transform (is the offer clear enough to deliver),
// Monetize (can you charge for it with a straight face).

export type QuizLetter = 'a' | 'b' | 'c' | 'd'
export type QuizPillar = 'attract' | 'transform' | 'monetize'

export const QUIZ_LETTERS: QuizLetter[] = ['a', 'b', 'c', 'd']
export const QUIZ_PILLARS: QuizPillar[] = ['attract', 'transform', 'monetize']

/** One option: the words the coach reads and what choosing it is worth, together. */
export type QuizOption = {
  letter: QuizLetter
  label: string
  /** 1 is the least ready answer and 4 the most, on every question. */
  points: number
}

export type QuizQuestion = {
  id: string
  pillar: QuizPillar
  prompt: string
  options: QuizOption[]
}

/**
 * The seven scored questions, in the order they are asked.
 *
 * ARRAY ORDER IS PRESENTATION ORDER and nothing else — scoring is keyed by
 * question id and by letter, so these can be resequenced without moving a single
 * score. That separation is deliberate: the one thing a frontend must never be
 * able to change by accident is what an answer is worth.
 */
export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'client_flow',
    pillar: 'attract',
    prompt: 'How consistent is your client flow right now?',
    options: [
      { letter: 'a', label: "Feast or famine — some months there's nothing", points: 1 },
      { letter: 'b', label: "The odd referral, but I can't predict when", points: 2 },
      { letter: 'c', label: "Fairly steady, but I'm chasing it every week", points: 3 },
      { letter: 'd', label: 'Predictable — I know roughly what next month looks like', points: 4 },
    ],
  },
  {
    id: 'biggest_challenge',
    pillar: 'transform',
    // These are four DIFFERENT problems rather than four degrees of one, so the
    // points say how far along somebody usually is when that particular problem
    // is the one in front of them. Not being able to deliver more is a problem
    // you only get to have once the thing sells.
    prompt: "What's your biggest challenge right now?",
    options: [
      { letter: 'a', label: 'Not enough people know I exist', points: 1 },
      { letter: 'b', label: "People are interested, but I can't explain the offer clearly", points: 2 },
      { letter: 'c', label: "They understand it and still don't buy at my price", points: 3 },
      { letter: 'd', label: "It sells, but I can't deliver more without breaking", points: 4 },
    ],
  },
  {
    id: 'lead_source',
    pillar: 'attract',
    prompt: 'Where do your leads come from?',
    options: [
      { letter: 'a', label: 'Nowhere reliable right now', points: 1 },
      { letter: 'b', label: 'Word of mouth, when it happens', points: 2 },
      { letter: 'c', label: 'One channel that works', points: 3 },
      { letter: 'd', label: 'More than one, and I know which does what', points: 4 },
    ],
  },
  {
    id: 'ideal_client',
    pillar: 'attract',
    prompt: 'How clear are you on who you help?',
    options: [
      { letter: 'a', label: "Anyone who'll pay me", points: 1 },
      { letter: 'b', label: 'A rough idea, but it moves', points: 2 },
      { letter: 'c', label: 'A defined niche I can describe', points: 3 },
      { letter: 'd', label: 'A named person, with evidence they buy', points: 4 },
    ],
  },
  {
    id: 'pricing_confidence',
    pillar: 'monetize',
    prompt: 'How confident are you in your pricing?',
    options: [
      { letter: 'a', label: 'I discount to close', points: 1 },
      { letter: 'b', label: 'I say the number, but I flinch', points: 2 },
      { letter: 'c', label: 'I hold my price', points: 3 },
      { letter: 'd', label: 'I raised it and still close', points: 4 },
    ],
  },
  {
    id: 'offer_clarity',
    pillar: 'transform',
    prompt: 'How clear is your offer?',
    options: [
      { letter: 'a', label: 'I struggle to say it at all', points: 1 },
      { letter: 'b', label: 'I can explain it, but it takes a paragraph', points: 2 },
      { letter: 'c', label: 'One sentence, and it mostly lands', points: 3 },
      { letter: 'd', label: 'One sentence buyers repeat back to me', points: 4 },
    ],
  },
  {
    id: 'ninety_day_goal',
    pillar: 'monetize',
    // Scored as a position, not an ambition: wanting to scale delivery implies
    // something already sells. A goal is evidence about where somebody IS.
    prompt: "What's your goal for the next ninety days?",
    options: [
      { letter: 'a', label: 'Land my first paying client', points: 1 },
      { letter: 'b', label: 'Get to consistent months', points: 2 },
      { letter: 'c', label: 'Raise my rates', points: 3 },
      { letter: 'd', label: 'Scale delivery without breaking', points: 4 },
    ],
  },
]

export const QUIZ_QUESTION_IDS = QUIZ_QUESTIONS.map((q) => q.id)

/**
 * The open question, asked last and never scored.
 *
 * Its wording lives here for the same reason the options do: Step 1 offers the
 * answer back to the coach as their own words, so the question that produced
 * those words is part of the contract, not frontend copy.
 */
export const QUIZ_PROBLEM_PROMPT = 'In your own words, what problem do you help people solve?'
export const QUIZ_PROBLEM_HELP =
  'However you would say it to someone at a dinner party. This is carried into Step 1 exactly as you write it.'

// Human-readable pillar names, here rather than in the frontend so the results
// screen, the gap line and any future email all say the same word.
export const PILLAR_LABEL: Record<QuizPillar, string> = {
  attract: 'Attract',
  transform: 'Transform',
  monetize: 'Monetize',
}

export type QuizAnswers = Record<string, QuizLetter>

export type QuizAnalysis = {
  scores: Record<QuizPillar, number>
  composite: number
  moniker: string
  moniker_summary: string
  gap: { pillar: QuizPillar; title: string; body: string }
  quick_win: { title: string; body: string }
}

/** What choosing `letter` on `question` is worth. One lookup, used everywhere. */
export function pointsFor(question: QuizQuestion, letter: QuizLetter): number {
  const option = question.options.find((o) => o.letter === letter)
  // Unreachable for a validated answer; throwing rather than defaulting to 0,
  // because a silently-zero question is a wrong composite nobody can see.
  if (!option) throw new Error(`no option '${letter}' on question '${question.id}'`)
  return option.points
}

/**
 * Normalise a pillar's raw points to 0-100.
 *
 * Against the pillar's OWN range rather than against its maximum, so 0 means
 * "the least ready answer to every question here" and 100 means "the most
 * ready". Dividing by the max instead would floor every pillar at 25 and make
 * the bottom of the scale unreachable.
 *
 * THIS ASSUMES EVERY QUESTION OFFERS A 1 AND A 4. A question scored
 * {a:2,b:3,c:4,d:4} would make 0 unreachable on its pillar; one scored above 4
 * would push a composite past 100 and out of every moniker band.
 * assertPointsTablesAreWellFormed pins that, and the suite runs it.
 */
function normalise(raw: number, questions: QuizQuestion[]): number {
  const min = questions.length * 1
  const max = questions.length * 4
  if (max === min) return 0
  return Math.round(((raw - min) / (max - min)) * 100)
}

/**
 * The moniker ladder, by composite.
 *
 * Bands are [min, max] inclusive and must cover 0-100 with no gap and no
 * overlap — `assertMonikerBandsCoverEveryScore` proves that for all 101 values
 * rather than leaving it to reading. A composite with no moniker would be a
 * results screen with an empty headline.
 */
export const MONIKER_BANDS: Array<{ min: number; max: number; name: string; summary: string }> = [
  {
    min: 0,
    max: 24,
    name: 'The Well-Kept Secret',
    summary: 'You can do the work. Almost nobody knows it yet, and that is the whole problem.',
  },
  {
    min: 25,
    max: 49,
    name: 'The Hidden Gem',
    summary: 'The people who find you tend to stay. Not enough of them find you.',
  },
  {
    min: 50,
    max: 74,
    name: 'The Steady Builder',
    summary: 'The pieces work. They do not yet work together reliably enough to plan around.',
  },
  {
    min: 75,
    max: 89,
    name: 'The Quiet Operator',
    summary: 'You have something that sells. The ceiling is how consistently you put it in front of people.',
  },
  {
    min: 90,
    max: 100,
    name: 'The Full Engine',
    summary: 'Attract, transform and monetize are all pulling. Now it is a question of volume.',
  },
]

/**
 * The gap and the quick win, per pillar.
 *
 * Keyed by the pillar that scored LOWEST, so the advice is always about the
 * thing actually holding the composite down. Fixed copy per pillar and not
 * generated: this is a diagnosis a coach acts on, so it says the same thing to
 * two coaches in the same position rather than being freshly worded each time.
 */
const PILLAR_ADVICE: Record<QuizPillar, { gap: string; winTitle: string; winBody: string }> = {
  attract: {
    gap: 'Not enough of the right people know what you do. Everything downstream is capped by that, however good the offer is.',
    winTitle: 'Name one person, not an audience',
    winBody:
      'Write down the single client you would most like ten more of, in one sentence, with the problem they came to you with. Every post, call and page gets easier once that sentence exists.',
  },
  transform: {
    gap: 'What you deliver is clearer in your head than it is out loud. Buyers cannot buy a thing they cannot repeat back.',
    winTitle: 'Say the offer in one sentence',
    winBody:
      'Compress it to who it is for, what changes, and roughly how long that takes. If you cannot say it without a caveat, that is the work — not the marketing.',
  },
  monetize: {
    gap: 'The work is worth more than you are currently able to ask for it, and discounting is doing the closing.',
    winTitle: 'Quote your next call without flinching',
    winBody:
      'Pick the number before the call, say it once, and stop talking. Nothing changes about the offer — the practice is in not negotiating against yourself.',
  },
}

/** The pillar the gap line is written about: lowest score, ties broken by fixed pillar order. */
export function lowestPillar(scores: Record<QuizPillar, number>): QuizPillar {
  // QUIZ_PILLARS order IS the tiebreak, and it is fixed — so two coaches with
  // the same tied scores get the same gap. Reducing over an unordered object's
  // keys would make the answer depend on insertion order, which is not
  // something a scoring rule may depend on.
  return QUIZ_PILLARS.reduce((low, p) => (scores[p] < scores[low] ? p : low), QUIZ_PILLARS[0])
}

export function monikerFor(composite: number): { name: string; summary: string } {
  const band = MONIKER_BANDS.find((b) => composite >= b.min && composite <= b.max)
  // Unreachable while the bands cover 0-100, which the assertion below pins.
  // Throwing rather than defaulting: a silently-wrong headline on a results
  // screen is worse than a 500 somebody notices.
  if (!band) throw new Error(`no moniker band for composite ${composite}`)
  return { name: band.name, summary: band.summary }
}

/**
 * Score a full set of answers.
 *
 * Pure: same input, same output, no clock, no randomness, no database. That is
 * what makes acceptance item 4 checkable by running it twice and comparing.
 */
export function scoreQuiz(answers: QuizAnswers): QuizAnalysis {
  const scores = {} as Record<QuizPillar, number>

  for (const pillar of QUIZ_PILLARS) {
    const questions = QUIZ_QUESTIONS.filter((q) => q.pillar === pillar)
    const raw = questions.reduce((sum, q) => sum + pointsFor(q, answers[q.id]), 0)
    scores[pillar] = normalise(raw, questions)
  }

  // The mean of the three NORMALISED pillars, so each pillar counts equally
  // regardless of how many questions it happens to hold. Attract has three and
  // the others two; summing raw points instead would quietly make Attract worth
  // half again as much as Monetize, which is not a decision anybody made.
  const composite = Math.round(QUIZ_PILLARS.reduce((sum, p) => sum + scores[p], 0) / QUIZ_PILLARS.length)

  const pillar = lowestPillar(scores)
  const advice = PILLAR_ADVICE[pillar]
  const moniker = monikerFor(composite)

  return {
    scores,
    composite,
    moniker: moniker.name,
    moniker_summary: moniker.summary,
    gap: { pillar, title: `Your biggest gap is ${PILLAR_LABEL[pillar]}`, body: advice.gap },
    quick_win: { title: advice.winTitle, body: advice.winBody },
  }
}

/**
 * The question set as the frontend receives it.
 *
 * POINTS ARE NOT SERVED. The frontend renders the words and posts back a letter;
 * what a letter is worth is the scoring rubric and stays server-side. Shipping it
 * would put the answer key on the page of a self-assessment, and a coach who can
 * see which option scores 4 is being invited to take a different quiz than the
 * one that helps them.
 *
 * Built from QUIZ_QUESTIONS by projection, never as a parallel list — that is the
 * whole point of the option text living beside its points.
 */
export type ServedQuestion = {
  id: string
  prompt: string
  options: Array<{ letter: QuizLetter; label: string }>
}

export function servedQuestions(): ServedQuestion[] {
  return QUIZ_QUESTIONS.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    options: q.options.map((o) => ({ letter: o.letter, label: o.label })),
  }))
}

export type AnswerCheck =
  | { ok: true; answers: QuizAnswers }
  | { ok: false; error: string; message: string }

/**
 * Validate the submitted letters.
 *
 * Every question must be present and every value must be an option that exists
 * ON THAT QUESTION — checked against its own option list rather than against the
 * alphabet, so a question that ever offers three choices cannot be answered with
 * a fourth.
 *
 * NO DEFAULTING A MISSING ANSWER — a skipped question silently scored as 'a'
 * would produce a real-looking composite built partly out of something the coach
 * never said, and there is no way to tell that from the stored row afterwards.
 */
export function validateQuizAnswers(raw: unknown): AnswerCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'answers_invalid', message: 'answers must be an object keyed by question id' }
  }
  const input = raw as Record<string, unknown>
  const answers: QuizAnswers = {}

  for (const question of QUIZ_QUESTIONS) {
    const value = input[question.id]
    const letter = typeof value === 'string' ? (value.toLowerCase() as QuizLetter) : null
    if (!letter || !question.options.some((o) => o.letter === letter)) {
      return {
        ok: false,
        error: 'answer_missing_or_invalid',
        message: `answer for '${question.id}' must be one of ${question.options.map((o) => o.letter).join(', ')}`,
      }
    }
    answers[question.id] = letter
  }

  // Unknown keys are dropped rather than rejected: the stored answers object is
  // built from QUIZ_QUESTIONS only, so a frontend sending an extra field cannot
  // get it persisted, and a stale client sending one is not an error worth
  // failing a completed quiz over.
  return { ok: true, answers }
}

/**
 * The open question's answer, stored VERBATIM.
 *
 * Trailing whitespace is trimmed at the ends and nothing else is touched — no
 * case folding, no punctuation normalising, no collapsing of blank lines. This
 * sentence is carried into Step 1 and offered back to the coach as their own
 * words, so anything done to it here is a word the coach did not write appearing
 * under their own name. lib/phrasing.ts is the standing example of what a
 * well-meaning sanitizer does to a paragraph.
 *
 * Empty is allowed. A coach may finish the quiz without answering it, and Step 1
 * already has to handle having no problem statement at all.
 */
export function normalizeProblemStatement(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

// ---------------------------------------------------------------------------
// The quiz's own invariants, exported so the suite proves them against the real
// tables rather than against a copy of them. Both return a list of failures so a
// broken table names every problem at once instead of one per run.
// ---------------------------------------------------------------------------

export function assertMonikerBandsCoverEveryScore(): string[] {
  const failures: string[] = []
  for (let score = 0; score <= 100; score++) {
    const hits = MONIKER_BANDS.filter((b) => score >= b.min && score <= b.max)
    if (hits.length !== 1) failures.push(`composite ${score} matched ${hits.length} bands`)
  }
  return failures
}

/**
 * What `normalise` assumes about every question, checked rather than trusted.
 *
 * The sibling to the band check, and it exists because the assumption is
 * invisible at the call site: normalise computes the range from the QUESTION
 * COUNT (n*1 to n*4), not from the points actually present. So a table that
 * drifts out of 1-4 does not fail — it produces a pillar whose floor is
 * unreachable, or a composite above 100 that then matches no moniker band and
 * throws from monikerFor, a long way from the edit that caused it.
 */
export function assertPointsTablesAreWellFormed(): string[] {
  const failures: string[] = []

  for (const q of QUIZ_QUESTIONS) {
    const letters = q.options.map((o) => o.letter)
    const points = q.options.map((o) => o.points)

    if (new Set(letters).size !== letters.length) failures.push(`${q.id}: duplicate option letters`)
    for (const l of letters) {
      if (!QUIZ_LETTERS.includes(l)) failures.push(`${q.id}: unknown option letter '${l}'`)
    }
    for (const p of points) {
      if (!Number.isInteger(p)) failures.push(`${q.id}: non-integer points ${p}`)
      if (p < 1 || p > 4) failures.push(`${q.id}: points ${p} outside 1-4 — a composite could exceed 100`)
    }
    // The two normalise actually depends on. Without a 1 the pillar's floor is
    // unreachable; without a 4 its ceiling is.
    if (!points.includes(1)) failures.push(`${q.id}: no option worth 1 — 0 is unreachable on ${q.pillar}`)
    if (!points.includes(4)) failures.push(`${q.id}: no option worth 4 — 100 is unreachable on ${q.pillar}`)

    if (!q.prompt.trim()) failures.push(`${q.id}: no prompt text`)
    for (const o of q.options) {
      if (!o.label.trim()) failures.push(`${q.id}: option '${o.letter}' has no label`)
    }
  }

  return failures
}
