// The ATM Quiz: seven multiple-choice questions, three sub-scores, one composite.
//
// EVERYTHING THAT DECIDES A NUMBER IS A TABLE IN THIS FILE. No points are
// computed in the handler, none are derived from the order options happen to
// appear in, and nothing reaches for the clock or a random seed. Same answers,
// same numbers, forever — which is the whole requirement: a coach who retakes
// the quiz and gets a different result for the same answers will not trust it,
// and neither will whoever is debugging it a year from now.
//
// The three pillars are the method's own: Attract (can people find you and do
// you know who they are), Transform (is the offer clear enough to deliver),
// Monetize (can you charge for it with a straight face).

export type QuizLetter = 'a' | 'b' | 'c' | 'd'
export type QuizPillar = 'attract' | 'transform' | 'monetize'

export const QUIZ_LETTERS: QuizLetter[] = ['a', 'b', 'c', 'd']
export const QUIZ_PILLARS: QuizPillar[] = ['attract', 'transform', 'monetize']

type QuizQuestion = {
  id: string
  pillar: QuizPillar
  /** What the option means, so the points below can be read without the quiz UI. */
  points: Record<QuizLetter, number>
}

/**
 * The seven scored questions.
 *
 * POINTS ARE WRITTEN PER LETTER, NOT DERIVED FROM POSITION. It would be shorter
 * to say "a=1, b=2, c=3, d=4 everywhere" and let each question order its own
 * options — and then reordering options in the frontend would silently change
 * every coach's score, with the quiz still looking correct on screen. Spelling
 * the mapping out here means the frontend can present options in any order it
 * likes and the numbers do not move.
 *
 * 1 is the least ready answer and 4 the most, on every question, so a raw sum
 * has a consistent direction.
 */
export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // "How consistent is your client flow right now?"
  // none -> occasional referrals -> steady but manual -> predictable pipeline
  { id: 'client_flow', pillar: 'attract', points: { a: 1, b: 2, c: 3, d: 4 } },

  // "Where do your leads come from?"
  // nowhere -> word of mouth only -> one channel working -> more than one
  { id: 'lead_source', pillar: 'attract', points: { a: 1, b: 2, c: 3, d: 4 } },

  // "How clear are you on your ideal client?"
  // anyone who'll pay -> a rough idea -> a defined niche -> named, with evidence
  { id: 'ideal_client', pillar: 'attract', points: { a: 1, b: 2, c: 3, d: 4 } },

  // "What's your biggest challenge?"
  // Not a ladder — these are four different problems, and the points say how
  // far along someone usually is when that problem is the one in front of them.
  // Finding people at all sits earlier than pricing what already works.
  { id: 'biggest_challenge', pillar: 'transform', points: { a: 1, b: 3, c: 2, d: 4 } },

  // "How clear is your offer?"
  // can't say it -> a paragraph -> one sentence -> one sentence buyers repeat
  { id: 'offer_clarity', pillar: 'transform', points: { a: 1, b: 2, c: 3, d: 4 } },

  // "How confident are you in your pricing?"
  // discount to close -> flinch saying it -> hold it -> raised it and still close
  { id: 'pricing_confidence', pillar: 'monetize', points: { a: 1, b: 2, c: 3, d: 4 } },

  // "What's your ninety-day goal?"
  // first paying client -> consistent months -> raise rates -> scale delivery
  // Scored as a position, not an ambition: wanting to scale delivery implies
  // something already sells. A goal is evidence about where somebody IS.
  { id: 'ninety_day_goal', pillar: 'monetize', points: { a: 1, b: 2, c: 3, d: 4 } },
]

export const QUIZ_QUESTION_IDS = QUIZ_QUESTIONS.map((q) => q.id)

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

export type QuizResult = {
  answers: QuizAnswers
  problem_statement: string
  score: number
  analysis: QuizAnalysis
}

/**
 * Normalise a pillar's raw points to 0-100.
 *
 * Against the pillar's OWN range rather than against its maximum, so 0 means
 * "the least ready answer to every question here" and 100 means "the most
 * ready". Dividing by the max instead would floor a three-question pillar at 25
 * and a two-question pillar at 25 as well — the same number meaning different
 * distances from the bottom, and no coach ever able to score below it.
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
 * overlap — `assertMonikerBandsCoverEveryScore` below proves that for all 101
 * values rather than leaving it to reading. A composite with no moniker would
 * be a results screen with an empty headline.
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
    const raw = questions.reduce((sum, q) => sum + q.points[answers[q.id]], 0)
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

export type AnswerCheck =
  | { ok: true; answers: QuizAnswers }
  | { ok: false; error: string; message: string }

/**
 * Validate the submitted letters.
 *
 * Every question must be present and every value must be one of four letters.
 * NO DEFAULTING A MISSING ANSWER — a skipped question silently scored as 'a'
 * would produce a real-looking composite built partly out of something the
 * coach never said, and there is no way to tell that from the stored row
 * afterwards.
 */
export function validateQuizAnswers(raw: unknown): AnswerCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'answers_invalid', message: 'answers must be an object keyed by question id' }
  }
  const input = raw as Record<string, unknown>
  const answers: QuizAnswers = {}

  for (const id of QUIZ_QUESTION_IDS) {
    const value = input[id]
    if (typeof value !== 'string' || !QUIZ_LETTERS.includes(value.toLowerCase() as QuizLetter)) {
      return {
        ok: false,
        error: 'answer_missing_or_invalid',
        message: `answer for '${id}' must be one of a, b, c, d`,
      }
    }
    answers[id] = value.toLowerCase() as QuizLetter
  }

  // Unknown keys are dropped rather than rejected: the stored answers object is
  // built from QUIZ_QUESTION_IDS only, so a frontend sending an extra field
  // cannot get it persisted, and a stale client sending one is not an error
  // worth failing a completed quiz over.
  return { ok: true, answers }
}

/**
 * The open question, stored VERBATIM.
 *
 * Trailing whitespace is trimmed at the ends and nothing else is touched — no
 * case folding, no punctuation normalising, no collapsing of blank lines. This
 * sentence is carried into Step 1 and offered back to the coach as their own
 * words, so anything done to it here is a word the coach did not write
 * appearing under their own name. lib/phrasing.ts is the standing example of
 * what a well-meaning sanitizer does to a paragraph.
 *
 * Empty is allowed. A coach may finish the quiz without answering it, and Step 1
 * already has to handle having no problem statement at all.
 */
export function normalizeProblemStatement(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

// The quiz's own invariants, exported so the test suite proves them against the
// real tables rather than against a copy of them.
export function assertMonikerBandsCoverEveryScore(): string[] {
  const failures: string[] = []
  for (let score = 0; score <= 100; score++) {
    const hits = MONIKER_BANDS.filter((b) => score >= b.min && score <= b.max)
    if (hits.length !== 1) failures.push(`composite ${score} matched ${hits.length} bands`)
  }
  return failures
}
