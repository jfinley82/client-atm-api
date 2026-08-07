import type { FrameworkPhase, FrameworkStep } from './frameworkAnalysis'
import type { ProgramAnalysis, WeeklyBreakdownEntry } from './programAnalysis'

// Reshaping a program to the coach's chosen length, cadence and session length.
//
// DETERMINISTIC, NOT GENERATED. The load-bearing property is that every step of
// the coach's framework appears somewhere in the plan on every shape — no step
// silently falling off the end because the arithmetic divided cleanly. A model
// cannot be held to that, and the same principle already governs PHASE_COLORS,
// resolveFrameworkName, match_strength and suggested_starting_price: the things
// that must be RIGHT are computed in the backend, and the model is only trusted
// with prose.
//
// So the session content here is derived from the framework's own steps — their
// names become the focus, the last step's `outcome` becomes the milestone —
// rather than paraphrased. A reshape re-cuts the coach's method against a new
// calendar; it does not reimagine it.

export type SessionCadence = 'weekly' | 'biweekly' | 'monthly'

// A NAME, not a multiplier. The three options are a closed set, and a number in
// the payload is a number somebody eventually gets wrong — 'biweekly' cannot be
// misread as 2 weeks of something else, and an unknown name is refusable.
export const SESSION_CADENCES: readonly SessionCadence[] = ['weekly', 'biweekly', 'monthly'] as const

// Weeks BETWEEN sessions. Monthly is 4 weeks rather than a calendar month
// because the container is measured in weeks; mixing the two units is how
// "12 weeks monthly" starts returning 4 sessions in one place and 3 in another.
const WEEKS_BETWEEN: Record<SessionCadence, number> = { weekly: 1, biweekly: 2, monthly: 4 }

export function isSessionCadence(value: unknown): value is SessionCadence {
  return typeof value === 'string' && (SESSION_CADENCES as readonly string[]).includes(value)
}

export const MIN_WEEKS = 1
export const MAX_WEEKS = 16
export const MIN_SESSION_MINUTES = 15
export const MAX_SESSION_MINUTES = 480

/**
 * How many times they actually meet inside the container.
 *
 * CADENCE CHANGES SESSIONS, NOT WEEKS. Twelve weeks bi-weekly is six sessions
 * across twelve weeks — it is not six weeks. `total_weeks` is the container the
 * client is in; `total_sessions` is how many times they meet inside it. Every
 * row that exists today has these as the same number, which is exactly the
 * condition under which two fields quietly become one.
 *
 * Counted as the meeting weeks themselves (1, 1+n, 1+2n, … ≤ total) rather than
 * a division, so the boundary cases are the real ones: 12 weekly is 12, 12
 * bi-weekly is 6, 12 monthly is 3, and 6 monthly is 2 rather than 1.5 rounded
 * by whichever way somebody happened to write it.
 */
export function sessionCountFor(totalWeeks: number, cadence: SessionCadence): number {
  const gap = WEEKS_BETWEEN[cadence]
  return Math.floor((totalWeeks - 1) / gap) + 1
}

/** The week number each session lands on. */
export function sessionWeeks(totalWeeks: number, cadence: SessionCadence): number[] {
  const gap = WEEKS_BETWEEN[cadence]
  const weeks: number[] = []
  for (let w = 1; w <= totalWeeks; w += gap) weeks.push(w)
  return weeks
}

type PlannedSession = { week: number; phase: FrameworkPhase; steps: FrameworkStep[] }

/**
 * Split `total` items into `groups` contiguous, order-preserving runs, as evenly
 * as possible, with the larger runs first. Returns the size of each run.
 * Guarantees the sizes sum to `total` — which is what stops a step falling off
 * the end.
 */
function evenSplit(total: number, groups: number): number[] {
  if (groups <= 0) return []
  const base = Math.floor(total / groups)
  const remainder = total % groups
  return Array.from({ length: groups }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * Lay the framework's phases and steps across the available sessions.
 *
 * Two modes, because the shapes are genuinely different problems:
 *
 *  - AT LEAST ONE SESSION PER PHASE (the normal case). Sessions are allocated to
 *    phases with a floor of one each, the remainder going to the phases with the
 *    most steps. That floor is what stops a phase disappearing at the smallest
 *    shape — three sessions and three phases is one each, not two for the phase
 *    that happens to be longest.
 *
 *  - FEWER SESSIONS THAN PHASES (1 or 2 sessions). No allocation can give every
 *    phase its own session, so the steps are split across the sessions directly
 *    and a session's phase label is that of the step it opens with. Every step is
 *    still placed exactly once; the plan simply says less about phases because
 *    there is not room to.
 *
 * In both modes, when a group has more sessions than steps the steps repeat
 * across consecutive sessions rather than leaving a session with nothing in it —
 * a sixteen-week container has room to spread, and an empty session is not a
 * plan.
 */
function planSessions(phases: FrameworkPhase[], weeks: number[]): PlannedSession[] {
  const allSteps = phases.flatMap((p) => p.steps.map((s) => ({ step: s, phase: p })))
  const sessionCount = weeks.length

  if (sessionCount < phases.length) {
    const sizes = evenSplit(allSteps.length, sessionCount)
    const out: PlannedSession[] = []
    let cursor = 0
    for (let i = 0; i < sessionCount; i++) {
      const slice = allSteps.slice(cursor, cursor + sizes[i])
      cursor += sizes[i]
      out.push({ week: weeks[i], phase: slice[0].phase, steps: slice.map((x) => x.step) })
    }
    return out
  }

  // One session per phase, then hand the surplus to the phases carrying the most
  // steps — a phase with three steps earns another session before a phase with
  // two does.
  const perPhase = phases.map(() => 1)
  let surplus = sessionCount - phases.length
  const byWeight = phases
    .map((p, i) => ({ i, steps: p.steps.length }))
    .sort((a, b) => b.steps - a.steps || a.i - b.i)
  let k = 0
  while (surplus > 0) {
    perPhase[byWeight[k % byWeight.length].i] += 1
    surplus -= 1
    k += 1
  }

  const out: PlannedSession[] = []
  let weekIndex = 0
  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]
    const slots = perPhase[p]
    if (slots >= phase.steps.length) {
      // More sessions than steps: each step holds for one or more consecutive
      // sessions. floor(i * steps / slots) never skips a step and never runs off
      // the end.
      for (let i = 0; i < slots; i++) {
        const stepIdx = Math.floor((i * phase.steps.length) / slots)
        out.push({ week: weeks[weekIndex++], phase, steps: [phase.steps[stepIdx]] })
      }
    } else {
      const sizes = evenSplit(phase.steps.length, slots)
      let cursor = 0
      for (let i = 0; i < slots; i++) {
        const slice = phase.steps.slice(cursor, cursor + sizes[i])
        cursor += sizes[i]
        out.push({ week: weeks[weekIndex++], phase, steps: slice })
      }
    }
  }
  return out
}

const CADENCE_PROSE: Record<SessionCadence, string> = {
  weekly: 'every week',
  biweekly: 'every other week',
  monthly: 'once a month',
}

/**
 * The reasoning paragraph, rewritten for the shape the coach actually chose.
 *
 * Regenerated rather than kept, because a paragraph arguing for twelve weeks
 * sitting under an eight-week plan is worse than no paragraph — the coach reads
 * it as the system's opinion of THEIR choice. Written from the numbers rather
 * than paraphrased, so it cannot describe a shape that is not the one stored.
 */
export function reshapeReasoning(input: {
  totalWeeks: number
  cadence: SessionCadence
  totalSessions: number
  sessionLengthMinutes: number
  frameworkName: string
  stepCount: number
  phaseCount: number
}): string {
  const { totalWeeks, cadence, totalSessions, sessionLengthMinutes, frameworkName, stepCount, phaseCount } = input
  const weekWord = totalWeeks === 1 ? 'week' : 'weeks'
  const sessionWord = totalSessions === 1 ? 'session' : 'sessions'

  const density =
    totalSessions >= stepCount
      ? `That gives each of the ${stepCount} steps room to land before the next one starts.`
      : `The ${stepCount} steps of ${frameworkName} are grouped across those ${sessionWord}, so some cover more than one step — every step is still worked, with less dwell time on each.`

  return (
    `${totalWeeks} ${weekWord}, meeting ${CADENCE_PROSE[cadence]} — ${totalSessions} ${sessionWord} ` +
    `of ${sessionLengthMinutes} minutes. All ${phaseCount} phases of ${frameworkName} are represented. ${density}`
  )
}

export type ReshapeInput = {
  total_weeks: number
  session_cadence: SessionCadence
  session_length_minutes: number
}

/**
 * Re-cut an existing program to a new shape.
 *
 * KEPT UNTOUCHED, deliberately: program_name, session_type, deliverables,
 * suggested_starting_price and suggested_capacity_per_month.
 *
 * The price especially. It is not a function of length and must not be
 * recalculated — the coach is being told on screen that their price comes from
 * the outcome and not the calendar, and a backend that quietly drops the number
 * when they shorten the container makes that a lie. Deliverables describe
 * outcomes rather than a schedule, so they survive a length change too.
 */
export function reshapeProgram(
  existing: ProgramAnalysis,
  framework: { frameworkName: string; phases: FrameworkPhase[] },
  input: ReshapeInput
): ProgramAnalysis {
  const weeks = sessionWeeks(input.total_weeks, input.session_cadence)
  const planned = planSessions(framework.phases, weeks)

  const weekly_breakdown: WeeklyBreakdownEntry[] = planned.map((s) => ({
    week: s.week,
    phase_name: s.phase.name,
    session_focus: s.steps.map((st) => st.name).join(' · '),
    // The last step's own stated outcome. The milestone a client reaches by the
    // end of a session IS the outcome of the last thing they did in it, so this
    // is the framework's own word for it rather than a new one.
    client_milestone: s.steps[s.steps.length - 1].outcome,
    step_ids: s.steps.map((st) => st.id),
  }))

  const stepCount = framework.phases.reduce((n, p) => n + p.steps.length, 0)

  return {
    ...existing,
    total_weeks: input.total_weeks,
    total_sessions: weeks.length,
    session_length_minutes: input.session_length_minutes,
    session_cadence: input.session_cadence,
    weekly_breakdown,
    timeline_reasoning: reshapeReasoning({
      totalWeeks: input.total_weeks,
      cadence: input.session_cadence,
      totalSessions: weeks.length,
      sessionLengthMinutes: input.session_length_minutes,
      frameworkName: framework.frameworkName,
      stepCount,
      phaseCount: framework.phases.length,
    }),
    // A reshape is a change to the artifact, so it goes back to draft for the
    // same reason a regenerate does — the coach confirms what they can see.
    confirmed: false,
  }
}
