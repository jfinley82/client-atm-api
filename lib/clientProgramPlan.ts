import { isValidWeeklyEntry } from './weeklyBreakdown'
import { MIN_WEEKS, MAX_WEEKS } from './programReshape'

// Turning a coach's confirmed program into ONE CLIENT'S PLAN.
//
// Pure, like lib/clientProgramSerializers.ts and for the same reason: create,
// resequence, week-deletion compaction and a moved start_date all have to derive
// the same dates from the same positions, and four copies of that arithmetic
// would be four answers to "when is week 3 due".

export type PlannedItem = {
  kind: 'week' | 'task' | 'milestone'
  sequence_position: number
  source_week: number
  sort_order: number
  title: string
  detail: string | null
  phase_name: string | null
  due_date: string | null
  due_date_source: 'derived' | 'manual'
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When position `n` is due: the LAST day of that position's week.
 *
 * `start_date + (n*7 - 1)` days, so position 1 of a program starting Monday the
 * 1st is due Sunday the 7th — the end of the week the client is living in, not
 * the start of the next one.
 *
 * Derived from `sequence_position` and NEVER from `source_week`. A client who
 * starts at their coach's week 4 is in position 1, and dating their first week
 * from week 4 would put its deadline three weeks in the past.
 */
export function derivedDueDate(startDate: string, sequencePosition: number): string | null {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(sequencePosition) || sequencePosition < 1) return null
  return new Date(start + (sequencePosition * 7 - 1) * DAY_MS).toISOString().slice(0, 10)
}

/** YYYY-MM-DD, and a real calendar date — `2026-02-30` parses in some engines. */
export function isValidStartDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  if (!Number.isFinite(t)) return false
  return new Date(t).toISOString().slice(0, 10) === v
}

export type PlanRejection =
  | { ok: false; reason: 'program_not_found' }
  | { ok: false; reason: 'program_not_confirmed' }
  | { ok: false; reason: 'program_empty' }
  | { ok: false; reason: 'program_too_long'; total_weeks: number }

export type PlanResult = { ok: true; items: PlannedItem[]; total_weeks: number; program_name: string } | PlanRejection

/**
 * The snapshot mapping (§5.2).
 *
 * TWO ROWS AT EVERY POSITION: the `week` row is the heading and its milestone is
 * the work. There is no such thing as a milestone-only position, which is what
 * lets the portal render a position from its week row without a null check on
 * every field — a renderer built against a gapped mapping concludes some
 * positions have no heading, and the mapping never produces one.
 *
 * A BLANK `client_milestone` PRODUCES NO MILESTONE ROW rather than an untitled
 * one. An empty row in a client's plan is worse than a week with only a focus.
 *
 * `sequence_position === source_week` everywhere at creation. They diverge only
 * on resequence, which is precisely when conflating them starts lying.
 */
export function planFromSnapshot(snapshot: unknown, startDate: string): PlanResult {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'program_not_found' }
  const s = snapshot as Record<string, unknown>

  // A program the coach has not confirmed is a draft of a draft — building a
  // client's plan from it would ship copy they never signed off.
  if (s.confirmed !== true) return { ok: false, reason: 'program_not_confirmed' }

  const breakdown = Array.isArray(s.weekly_breakdown) ? s.weekly_breakdown : []
  if (!breakdown.length || !breakdown.every(isValidWeeklyEntry)) return { ok: false, reason: 'program_empty' }

  // Length comes from the breakdown, not from total_weeks: the rows are what a
  // client actually walks through, and a total_weeks that disagrees with them is
  // a number, not a plan.
  const total_weeks = breakdown.length
  // NOT CLAMPED. Silently halving a coach's program is a change they would never
  // see; refusing it with the number is a change they can act on. The bound is
  // MAX_WEEKS from lib/programReshape.ts, the same one the database CHECK mirrors.
  if (total_weeks > MAX_WEEKS || total_weeks < MIN_WEEKS) return { ok: false, reason: 'program_too_long', total_weeks }

  const items: PlannedItem[] = []
  breakdown.forEach((raw, index) => {
    const entry = raw as { phase_name: string; session_focus: string; client_milestone: string }
    // Position from the ROW'S ORDER, not from entry.week. A snapshot whose weeks
    // are numbered 2,3,4 would otherwise create a plan with no position 1 and a
    // gap the program's own resequence endpoint would reject as non-contiguous.
    const position = index + 1
    const sourceWeek = position

    items.push({
      kind: 'week',
      sequence_position: position,
      source_week: sourceWeek,
      sort_order: 0,
      title: entry.session_focus,
      detail: null,
      phase_name: entry.phase_name,
      // A heading is not due. Dating it would put two deadlines in every week.
      due_date: null,
      due_date_source: 'derived',
    })

    if (entry.client_milestone.trim()) {
      items.push({
        kind: 'milestone',
        sequence_position: position,
        source_week: sourceWeek,
        sort_order: 1,
        title: entry.client_milestone,
        detail: null,
        phase_name: entry.phase_name,
        due_date: derivedDueDate(startDate, position),
        due_date_source: 'derived',
      })
    }
  })

  return { ok: true, items, total_weeks, program_name: typeof s.program_name === 'string' ? s.program_name : '' }
}

/**
 * Re-derive dates after the positions or the start date move.
 *
 * TWO ROWS ARE LEFT ALONE, for different reasons:
 *
 * - `manual` — a date the coach typed is a decision. Recomputing it silently
 *   overwrites that decision with no way to tell which ones were theirs, which
 *   is the entire reason due_date_source exists rather than being inferred.
 * - ALREADY UNDATED — re-derivation MOVES a date, it does not create one. A
 *   `week` row is a heading and carries no date by design, and a coach-added
 *   task with no date has not been given one; inventing deadlines for both the
 *   moment someone shifts start_date would put a heading in the client's
 *   upcoming list and a due date on work nobody scheduled.
 */
export function redriveDueDates<T extends { sequence_position: number; due_date: string | null; due_date_source: 'derived' | 'manual' }>(
  items: T[],
  startDate: string
): T[] {
  return items.map((i) =>
    i.due_date_source === 'manual' || i.due_date === null ? i : { ...i, due_date: derivedDueDate(startDate, i.sequence_position) }
  )
}

/**
 * How many calls the client is entitled to.
 *
 * THE SNAPSHOT VALUE IS A SUGGESTION, NOT A CONTRACT — the coach edits it on the
 * way through, so a create must never fail because the suggestion was unusable.
 * The body wins when present; the snapshot prefills when it can; only when
 * NEITHER is usable does the caller have to be asked.
 *
 * 0 is a legal answer both ways: a program with no calls in it is a real
 * product, so `sessions_allowed: 0` in the body is a choice, not a missing value.
 */
export function resolveSessionsAllowed(bodyValue: unknown, snapshot: unknown): { ok: true; value: number } | { ok: false; reason: 'sessions_allowed_required' } {
  const fromBody = coerceCount(bodyValue)
  if (fromBody !== null) return { ok: true, value: fromBody }

  const s = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>
  const suggested = coerceCount(s.total_sessions)
  if (suggested !== null) return { ok: true, value: suggested }

  return { ok: false, reason: 'sessions_allowed_required' }
}

// Math.round(Number(...)) per §13.4, with the range the 095 CHECK enforces. A
// value the database would reject is not a usable suggestion, so it falls
// through to the body rather than becoming a 500 at insert time.
function coerceCount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0 || n > 200) return null
  return n
}
