// The ATM Quiz: eight multiple-choice questions — seven scored into three
// sub-scores and one composite, plus one that names the coach's own gap.
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

/**
 * What the gap line and quick win are about.
 *
 * 'capacity' is NOT a pillar and is deliberately not one: "it sells but I can't
 * deliver more" is a constraint no amount of attracting, clarifying or pricing
 * addresses, and nothing in the scored questions measures it. It can be STATED
 * and acted on without being scored, which is exactly why the question that
 * names it is not scored either.
 */
export type GapFocus = QuizPillar | 'capacity'

/** One scored option: the words the coach reads and what choosing it is worth. */
export type ScoredOption = {
  letter: QuizLetter
  label: string
  /** 1 is the least ready answer and 4 the most, on every scored question. */
  points: number
}

/** One option on the unscored question: the words, and which gap they name. */
export type FocusOption = {
  letter: QuizLetter
  label: string
  focus: GapFocus
}

export type ScoredQuestion = {
  kind: 'scored'
  id: string
  pillar: QuizPillar
  prompt: string
  options: ScoredOption[]
}

/**
 * The question the coach answers about their own gap, which is NOT scored.
 *
 * WHY IT STOPPED BEING SCORED. It used to add points to Transform while its four
 * options name an Attract problem, a Transform problem, a Monetize problem and a
 * capacity problem — so a coach who answered "one sentence buyers repeat back to
 * me" on offer clarity and then "not enough people know I exist" here scored
 * Attract 100, Transform 50, and was told their offer was unclear while they were
 * telling the quiz nobody could find them. Answering the pricing option dragged
 * Transform to 83 with Monetize sitting at 100. Measured, not reasoned about.
 *
 * It is now the PRIMARY source of the gap line: this is the one question where
 * the coach states their constraint outright, and that is better evidence than a
 * minimum derived from the scored ones. The answer is still stored, and travels in
 * the result so Step 1 can use it alongside the problem statement.
 */
export type FocusQuestion = {
  kind: 'focus'
  id: string
  prompt: string
  options: FocusOption[]
}

export type QuizQuestion = ScoredQuestion | FocusQuestion

/**
 * Every multiple-choice question, in the order they are asked. Seven are scored;
 * one names the gap and is not. The open problem question is NOT here — it is
 * not multiple choice and does not belong in the same loop.
 *
 * ARRAY ORDER IS PRESENTATION ORDER and nothing else — scoring is keyed by
 * question id and by letter, so these can be resequenced without moving a single
 * score. That separation is deliberate: the one thing a frontend must never be
 * able to change by accident is what an answer is worth.
 */
export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    kind: 'scored',
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
    kind: 'focus',
    id: 'biggest_challenge',
    // NOT SCORED, and not a ladder either. Each option names a DIFFERENT
    // constraint, so there is no ordering along which one could be worth more
    // points than another — which is why the previous 1,2,3,4 was wrong twice
    // over: it summed a pricing statement into Transform, and it implied that
    // naming a delivery problem meant you were further along than naming a
    // visibility one. The answer selects what the advice is ABOUT instead.
    prompt: "What's your biggest challenge right now?",
    options: [
      { letter: 'a', label: 'Not enough people know I exist', focus: 'attract' },
      { letter: 'b', label: "People are interested, but I can't explain the offer clearly", focus: 'transform' },
      { letter: 'c', label: "They understand it and still don't buy at my price", focus: 'monetize' },
      { letter: 'd', label: "It sells, but I can't deliver more without breaking", focus: 'capacity' },
    ],
  },
  {
    kind: 'scored',
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
    kind: 'scored',
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
    kind: 'scored',
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
    kind: 'scored',
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
    kind: 'scored',
    id: 'delivery_repeatability',
    pillar: 'transform',
    // The other half of Transform. offer_clarity asks whether the offer can be
    // SAID; this asks whether it can be DELIVERED repeatably, which is what
    // Step 2 works on. Added 2026-08-06 after biggest_challenge stopped being
    // scored left Transform resting on one question — it could then only read
    // 0, 33, 67 or 100 while Attract moved in ten steps, so the results bars
    // would have looked jumpy next to each other for a reason nobody could see.
    prompt: 'How repeatable is the way you deliver results?',
    options: [
      { letter: 'a', label: 'Every client is different and I improvise', points: 1 },
      { letter: 'b', label: 'A rough process, but I rework it each time', points: 2 },
      { letter: 'c', label: 'A defined process most clients go through', points: 3 },
      { letter: 'd', label: 'Documented well enough that someone else could run it', points: 4 },
    ],
  },
  {
    kind: 'scored',
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

/** The ones that produce numbers. Derived, never a second hand-written list. */
export const SCORED_QUESTIONS = QUIZ_QUESTIONS.filter((q): q is ScoredQuestion => q.kind === 'scored')

/** The one that names the gap. Derived the same way, and there is exactly one. */
export const FOCUS_QUESTION = QUIZ_QUESTIONS.find((q): q is FocusQuestion => q.kind === 'focus')!

// Transform holds two questions as of 2026-08-06. It briefly held one, when
// biggest_challenge stopped being scored, and that was correct but coarse: a
// one-question pillar can only read 0, 33, 67 or 100 while Attract moves in ten
// steps, so the results bars would have looked jumpy for a reason nobody could
// see. delivery_repeatability was proposed rather than invented, and wired in
// only after Jamaul approved the wording unchanged.

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

export const FOCUS_LABEL: Record<GapFocus, string> = {
  attract: 'Attract',
  transform: 'Transform',
  monetize: 'Monetize',
  capacity: 'Delivery capacity',
}

export type QuizAnalysis = {
  scores: Record<QuizPillar, number>
  composite: number
  moniker: string
  moniker_summary: string
  /**
   * `focus` is null when there is no meaningful gap to name — see GAP_FLOOR.
   *
   * `resolution` says how the two signals were reconciled, and `disputed` carries
   * what the coach named when the evidence pointed elsewhere. Both are exposed
   * rather than kept internal so the results screen and Step 1 can tell a
   * confirmed diagnosis from a resolved disagreement — and so nothing downstream
   * has to re-derive it and get a different answer.
   *
   * The frontend renders the same two cards in every case; only the copy
   * changes, so there is no branch it can forget.
   */
  gap: {
    focus: GapFocus | null
    resolution: 'none' | 'stated' | 'conflict'
    disputed: GapFocus | null
    title: string
    body: string
  }
  quick_win: { title: string; body: string }
  /**
   * What the coach SAID, kept whole and separate from what was derived. Step 1
   * reads this alongside the problem statement, and keeping the raw letter and
   * label here means it never has to re-look-up the question set to know what
   * was answered.
   */
  stated_challenge: { letter: QuizLetter; label: string; focus: GapFocus }
}

/** What choosing `letter` on a scored question is worth. One lookup, used everywhere. */
export function pointsFor(question: ScoredQuestion, letter: QuizLetter): number {
  const option = question.options.find((o) => o.letter === letter)
  // Unreachable for a validated answer; throwing rather than defaulting to 0,
  // because a silently-zero question is a wrong composite nobody can see.
  if (!option) throw new Error(`no option '${letter}' on question '${question.id}'`)
  return option.points
}

/** Which gap the coach named. */
export function focusFor(letter: QuizLetter): GapFocus {
  const option = FOCUS_QUESTION.options.find((o) => o.letter === letter)
  if (!option) throw new Error(`no option '${letter}' on question '${FOCUS_QUESTION.id}'`)
  return option.focus
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
function normalise(raw: number, questions: ScoredQuestion[]): number {
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
export const MONIKER_BANDS: Array<{
  min: number
  max: number
  name: string
  summary: string
  /**
   * Does this band's own summary assert a business that is actually SELLING?
   *
   * Declared on the band rather than inferred from the prose, so the copy and
   * the flag cannot drift. It is what CAPACITY_EVIDENCE_FLOOR is derived from:
   * "the offer sells and the constraint is delivery" may only be printed where
   * the band already says the pieces work.
   */
  working: boolean
}> = [
  {
    min: 0,
    max: 24,
    name: 'The Well-Kept Secret',
    summary: 'You can do the work. Almost nobody knows it yet, and that is the whole problem.',
    working: false,
  },
  {
    min: 25,
    max: 49,
    name: 'The Hidden Gem',
    summary: 'The people who find you tend to stay. Not enough of them find you.',
    working: false,
  },
  {
    min: 50,
    max: 74,
    name: 'The Steady Builder',
    summary: 'The pieces work. They do not yet work together reliably enough to plan around.',
    working: true,
  },
  {
    min: 75,
    max: 89,
    name: 'The Quiet Operator',
    summary: 'You have something that sells. The ceiling is how consistently you put it in front of people.',
    working: true,
  },
  {
    min: 90,
    max: 100,
    name: 'The Full Engine',
    summary: 'Attract, transform and monetize are all pulling. Now it is a question of volume.',
    working: true,
  },
]

/**
 * The gap and the quick win, per focus.
 *
 * Keyed by the gap the coach NAMED, not by the pillar that scored lowest.
 * Fixed copy per focus and not generated: this is a diagnosis a coach acts on,
 * so it says the same thing to two coaches in the same position rather than
 * being freshly worded each time.
 */
const FOCUS_ADVICE: Record<GapFocus, { gap: string; winTitle: string; winBody: string }> = {
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
  capacity: {
    gap: 'The offer sells and the constraint is delivery. Every client you add from here costs hours you do not have, which is not a problem more leads or a better page can solve.',
    winTitle: 'Take one hour out of every delivery',
    winBody:
      'Find the single step you repeat for every client and turn it into a template, a recording or a checklist. Do it once, and the next ten clients cost you less than the last ten did.',
  },
}

/**
 * What the page says when there is no meaningful gap to name.
 *
 * This state exists because the old code had no floor: lowestPillar returned a
 * pillar unconditionally, so a coach scoring 100/100/100 read the moniker "The
 * Full Engine" and, directly beneath it, "Your biggest gap is Attract — not
 * enough of the right people know what you do." Three pillars tied at the top
 * and the tiebreak order printed a gap that did not exist.
 */
const NO_GAP_ADVICE = {
  title: 'No single gap is holding you back',
  body: 'Every pillar you were measured on is scoring in the top band, and nothing in your answers points at one thing to fix. From here the constraint is volume and consistency, not a missing piece.',
  winTitle: 'Do more of what already worked',
  winBody:
    'Look at where your last three clients actually came from and put the next thirty days into that one route. At this score the risk is redesigning something that is working, not failing to improve it.',
}

/**
 * The score at or above which a pillar is not a gap worth naming.
 *
 * DERIVED FROM THE TOP MONIKER BAND rather than written as its own number, so
 * "no meaningful gap" and "The Full Engine" cannot drift apart into a page that
 * calls you a full engine and names a gap anyway. Moving the band moves the
 * floor, deliberately — assertGapFloorMatchesTopBand pins the relationship.
 */
export const GAP_FLOOR = MONIKER_BANDS[MONIKER_BANDS.length - 1].min

/**
 * The composite at or above which "the offer sells" is an evidenced claim.
 *
 * Derived from the lowest band that DECLARES a working business, not chosen.
 * The capacity advice makes a factual assertion about the coach's business —
 * "the offer sells and the constraint is delivery" — and a claim like that needs
 * evidence before it may be printed. Measured: 172 of 16384 combinations named
 * Delivery capacity at composite 0 with all three pillars at 0, directly under a
 * moniker whose own summary says almost nobody knows they exist.
 */
export const CAPACITY_EVIDENCE_FLOOR = MONIKER_BANDS.find((b) => b.working)!.min

/**
 * The smallest difference between two pillars that means anything.
 *
 * DERIVED FROM THE INSTRUMENT, not picked to make a sweep go quiet. Each pillar
 * moves in steps of 100/(3n) for its n questions — Attract 11.1, Monetize 16.7,
 * Transform 33.3 — so the finest movement anything can make is ~11 points. Two
 * pillars differing by less than one step of the finest pillar is below the
 * resolution of the quiz; at or above it, the scores are genuinely saying one is
 * lower than the other.
 *
 * Recomputed from the tables, so adding the proposed second Transform question
 * (or any other) re-derives it instead of leaving a stale constant behind.
 */
export const MATERIAL_MARGIN = Math.ceil(
  Math.min(...QUIZ_PILLARS.map((p) => 100 / (3 * SCORED_QUESTIONS.filter((q) => q.pillar === p).length)))
)

export type GapResolution =
  | { kind: 'none' }
  | { kind: 'stated'; focus: GapFocus }
  | { kind: 'conflict'; stated: GapFocus; evidenced: QuizPillar }

/** The lowest-scoring pillar, ties broken by fixed pillar order so it is stable. */
export function weakestPillar(scores: Record<QuizPillar, number>): QuizPillar {
  return QUIZ_PILLARS.reduce((low, p) => (scores[p] < scores[low] ? p : low), QUIZ_PILLARS[0])
}

/**
 * Which gap the result is about, given what the coach SAID and what they SCORED.
 *
 * THE RULE: the results screen may not assert something the scores contradict.
 *
 * Two signals, and neither is allowed to be the last writer that wins. Letting
 * the SCORE win produced the first defect — a coach who answered "one sentence
 * buyers repeat back to me" was told their offer was unclear. Letting the
 * STATEMENT win produced the next two: in 3156 of 16384 combinations the gap
 * named the coach's STRONGEST pillar (measured: Attract 0, Transform 0,
 * Monetize 17, and the page said "Your biggest gap is Monetize"), and in 172 it
 * asserted a selling business at composite 0.
 *
 * So where they disagree materially, the page RESOLVES the disagreement instead
 * of picking a side silently. It names the pillar the evidence supports and says
 * out loud that the coach named something else — which is more useful than
 * either signal alone, and is the only outcome that asserts nothing contradicted.
 *
 * Order matters and is not arbitrary:
 *
 *  1. Capacity without evidence is a conflict. No pillar measures delivery, so
 *     nothing can confirm it either — but "the offer sells" is checkable, and
 *     below CAPACITY_EVIDENCE_FLOOR the scores say it does not.
 *  2. A stated pillar sitting materially ABOVE the weakest is a conflict. This
 *     subsumes "stated is the strictly highest" and also catches the tied case,
 *     as one rule rather than two.
 *  3. Only then, no-meaningful-gap: everything is within a step of everything
 *     else AND the stated pillar is in the top band. Checked after the conflict
 *     rules on purpose — Attract 100 / Transform 0 with Attract stated used to
 *     fall in here and print "no single gap is holding you back" over a pillar
 *     at zero.
 *  4. Otherwise the coach's statement stands, because nothing contradicts it.
 */
export function resolveGap(scores: Record<QuizPillar, number>, stated: GapFocus): GapResolution {
  const weakest = weakestPillar(scores)
  const composite = Math.round(QUIZ_PILLARS.reduce((sum, p) => sum + scores[p], 0) / QUIZ_PILLARS.length)

  if (stated === 'capacity') {
    if (composite < CAPACITY_EVIDENCE_FLOOR) return { kind: 'conflict', stated, evidenced: weakest }
    return { kind: 'stated', focus: stated }
  }

  // THE HARM IS NAMING THE BEST THING AS THE GAP, and the condition is written
  // as that harm rather than as a proxy for it.
  //
  // An earlier attempt fired whenever the stated pillar sat materially above the
  // WEAKEST, which put 8682 of 16384 results into conflict — the page arguing
  // with the coach in more than half of all cases. That is over-firing, not
  // safety: a coach who names a pillar scoring 67 while another scores 33 is not
  // being contradicted, because 67 is not good. There is real room at 67 and
  // three questions cannot see their business better than they can.
  //
  // The scores only contradict the statement when the named pillar is the single
  // BEST of the three and something else is materially below it. Then "your
  // biggest gap is X" is false on its face.
  const values = QUIZ_PILLARS.map((p) => scores[p])
  const isStrictlyHighest = values.filter((v) => v === scores[stated]).length === 1 && values.every((v) => v <= scores[stated])
  if (isStrictlyHighest && scores[stated] - scores[weakest] >= MATERIAL_MARGIN) {
    return { kind: 'conflict', stated, evidenced: weakest }
  }

  if (scores[stated] >= GAP_FLOOR) return { kind: 'none' }

  return { kind: 'stated', focus: stated }
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
    const questions = SCORED_QUESTIONS.filter((q) => q.pillar === pillar)
    const raw = questions.reduce((sum, q) => sum + pointsFor(q, answers[q.id]), 0)
    scores[pillar] = normalise(raw, questions)
  }

  // The mean of the three NORMALISED pillars, so each pillar counts equally
  // regardless of how many questions it happens to hold. Attract has three and
  // the others one or two; summing raw points instead would quietly make Attract
  // worth three times Transform, which is not a decision anybody made.
  const composite = Math.round(QUIZ_PILLARS.reduce((sum, p) => sum + scores[p], 0) / QUIZ_PILLARS.length)

  const stated = focusFor(answers[FOCUS_QUESTION.id])
  const resolved = resolveGap(scores, stated)
  const moniker = monikerFor(composite)

  let gap: QuizAnalysis['gap']
  let win: QuizAnalysis['quick_win']

  if (resolved.kind === 'none') {
    gap = { focus: null, resolution: 'none', disputed: null, title: NO_GAP_ADVICE.title, body: NO_GAP_ADVICE.body }
    win = { title: NO_GAP_ADVICE.winTitle, body: NO_GAP_ADVICE.winBody }
  } else if (resolved.kind === 'conflict') {
    // The page names what the evidence supports and SAYS the coach named
    // something else, rather than silently overriding them. Both signals stay
    // visible, and nothing is asserted that the scores contradict.
    gap = {
      focus: resolved.evidenced,
      resolution: 'conflict',
      disputed: resolved.stated,
      title: `Your biggest gap is ${FOCUS_LABEL[resolved.evidenced]}`,
      body:
        stated === 'capacity'
          ? `You named delivery capacity, and that may well be what it feels like. Your answers do not yet show an offer that is selling, though, and they put ${FOCUS_LABEL[resolved.evidenced]} lowest. ${FOCUS_ADVICE[resolved.evidenced].gap}`
          : `You named ${FOCUS_LABEL[stated]}, and it is the strongest of the three on your answers rather than the weakest. ${FOCUS_LABEL[resolved.evidenced]} is what they put lowest. ${FOCUS_ADVICE[resolved.evidenced].gap}`,
    }
    win = { title: FOCUS_ADVICE[resolved.evidenced].winTitle, body: FOCUS_ADVICE[resolved.evidenced].winBody }
  } else {
    gap = {
      focus: resolved.focus,
      resolution: 'stated',
      disputed: null,
      title: `Your biggest gap is ${FOCUS_LABEL[resolved.focus]}`,
      body: FOCUS_ADVICE[resolved.focus].gap,
    }
    win = { title: FOCUS_ADVICE[resolved.focus].winTitle, body: FOCUS_ADVICE[resolved.focus].winBody }
  }

  const statedLetter = answers[FOCUS_QUESTION.id]
  return {
    scores,
    composite,
    moniker: moniker.name,
    moniker_summary: moniker.summary,
    gap,
    quick_win: win,
    // Kept even when the gap is suppressed: what the coach said is still true
    // and Step 1 still wants it. Only the advice is withheld, not the answer.
    stated_challenge: {
      letter: statedLetter,
      label: FOCUS_QUESTION.options.find((o) => o.letter === statedLetter)!.label,
      focus: stated,
    },
  }
}

/**
 * The question set as the frontend receives it.
 *
 * NEITHER POINTS NOR FOCUS ARE SERVED. The frontend renders the words and posts
 * back a letter; what a letter is worth, and which gap it names, are the rubric
 * and stay server-side. Shipping either would put the answer key on the page of a
 * self-assessment — and `focus` in particular would let a coach pick which advice
 * they get rather than answer the question.
 *
 * Built from QUIZ_QUESTIONS by projection, never as a parallel list — that is the
 * whole point of the option text living beside its points. Both question kinds
 * project to the same shape on purpose: the frontend renders them identically and
 * has no reason to know which one is scored.
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
    options: (q.options as Array<{ letter: QuizLetter; label: string }>).map((o) => ({
      letter: o.letter,
      label: o.label,
    })),
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
    // The unscored question is required too: it is what the gap line is built
    // from, so a submission without it has no diagnosis, only numbers.
    if (!letter || !(question.options as Array<{ letter: QuizLetter }>).some((o) => o.letter === letter)) {
      return {
        ok: false,
        error: 'answer_missing_or_invalid',
        message: `answer for '${question.id}' must be one of ${(question.options as Array<{ letter: QuizLetter }>)
          .map((o) => o.letter)
          .join(', ')}`,
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

  // Shape checks that apply to BOTH kinds — a question the coach cannot read or
  // answer is broken whether or not it produces a number.
  for (const q of QUIZ_QUESTIONS) {
    const options = q.options as Array<{ letter: QuizLetter; label: string }>
    const letters = options.map((o) => o.letter)

    if (new Set(letters).size !== letters.length) failures.push(`${q.id}: duplicate option letters`)
    for (const l of letters) {
      if (!QUIZ_LETTERS.includes(l)) failures.push(`${q.id}: unknown option letter '${l}'`)
    }
    if (!q.prompt.trim()) failures.push(`${q.id}: no prompt text`)
    for (const o of options) {
      if (!o.label.trim()) failures.push(`${q.id}: option '${o.letter}' has no label`)
    }
  }

  // Points checks, on the scored questions only.
  for (const q of SCORED_QUESTIONS) {
    const points = q.options.map((o) => o.points)
    for (const p of points) {
      if (!Number.isInteger(p)) failures.push(`${q.id}: non-integer points ${p}`)
      if (p < 1 || p > 4) failures.push(`${q.id}: points ${p} outside 1-4 — a composite could exceed 100`)
    }
    // The two normalise actually depends on. Without a 1 the pillar's floor is
    // unreachable; without a 4 its ceiling is.
    if (!points.includes(1)) failures.push(`${q.id}: no option worth 1 — 0 is unreachable on ${q.pillar}`)
    if (!points.includes(4)) failures.push(`${q.id}: no option worth 4 — 100 is unreachable on ${q.pillar}`)
  }

  // Every pillar must still have at least one scored question, or its score is
  // a constant nobody can move. Making biggest_challenge unscored is exactly the
  // kind of edit that could have emptied one.
  for (const pillar of QUIZ_PILLARS) {
    if (!SCORED_QUESTIONS.some((q) => q.pillar === pillar)) {
      failures.push(`${pillar}: no scored question — the pillar cannot vary`)
    }
  }

  // Exactly one focus question, and its options must cover every focus the
  // advice table can key on. A focus with no option is copy nobody can reach;
  // an option with a focus the advice lacks is a crash on the results screen.
  const focusQuestions = QUIZ_QUESTIONS.filter((q) => q.kind === 'focus')
  if (focusQuestions.length !== 1) failures.push(`expected exactly one focus question, found ${focusQuestions.length}`)
  const covered = new Set(FOCUS_QUESTION.options.map((o) => o.focus))
  for (const f of [...QUIZ_PILLARS, 'capacity'] as GapFocus[]) {
    if (!covered.has(f)) failures.push(`no option on ${FOCUS_QUESTION.id} names '${f}'`)
    if (!FOCUS_ADVICE[f]) failures.push(`no advice copy for focus '${f}'`)
  }

  return failures
}

/**
 * The gap floor and the top moniker band must be the same number.
 *
 * They are, by construction — GAP_FLOOR is derived from the band — and this
 * asserts the construction rather than the value, so replacing the derivation
 * with a literal fails here instead of silently allowing "The Full Engine" to
 * appear above a named gap again.
 */
export function assertGapFloorMatchesTopBand(): string[] {
  const failures: string[] = []
  const top = MONIKER_BANDS[MONIKER_BANDS.length - 1]
  if (GAP_FLOOR !== top.min) {
    failures.push(`GAP_FLOOR ${GAP_FLOOR} does not match the top band's floor ${top.min} — a full-engine score could still name a gap`)
  }

  // The capacity floor is the lowest band that DECLARES a working business.
  // Replacing the derivation with a literal fails here rather than letting
  // "the offer sells" print over a moniker that says nobody has found them.
  const firstWorking = MONIKER_BANDS.find((b) => b.working)
  if (!firstWorking) failures.push('no moniker band declares a working business — capacity could never be named')
  else if (CAPACITY_EVIDENCE_FLOOR !== firstWorking.min) {
    failures.push(`CAPACITY_EVIDENCE_FLOOR ${CAPACITY_EVIDENCE_FLOOR} does not match the lowest working band ${firstWorking.min}`)
  }
  // The flag has to be monotonic, or "lowest working band" is not a threshold.
  const flags = MONIKER_BANDS.map((b) => b.working)
  if (flags.some((w, i) => w && flags.slice(i).some((later) => !later))) {
    failures.push('the working flag is not monotonic — a higher band claims less than a lower one')
  }

  // The margin has to come from the tables, not from a literal that survives a
  // question being added or removed.
  const expected = Math.ceil(
    Math.min(...QUIZ_PILLARS.map((p) => 100 / (3 * SCORED_QUESTIONS.filter((q) => q.pillar === p).length)))
  )
  if (MATERIAL_MARGIN !== expected) {
    failures.push(`MATERIAL_MARGIN ${MATERIAL_MARGIN} is not the finest pillar step ${expected} — it has been pinned to a literal`)
  }

  return failures
}
