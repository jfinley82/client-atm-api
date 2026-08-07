import { MANAGE_CUTOFF_MS } from './bookingManage'

// EVERY client-program response is built here, and every derived number is
// computed here rather than stored.
//
// PURE FUNCTIONS OVER ROWS. Nothing in this file reads the database, which is
// what lets scripts/served-contract.mjs run the REAL serializers over a
// synthetic probe and emit docs/served-contract.md from behaviour rather than
// from a hand-written list. A contract that is transcribed is a fifth place for
// a name to drift; a contract that is generated fails the gate when the code
// changes and the document does not.
//
// DERIVED AT READ TIME, NEVER STORED — the same discipline as the SLA logic in
// lib/support.ts. No progress column, no sessions_used counter: a rule change
// then reprices history instead of leaving rows stamped against the old rule.

// ---------------------------------------------------------------------------
// Row shapes, as they come out of 095. Deliberately narrow: a serializer that
// accepts the whole row is one refactor away from passing a secret through.
// ---------------------------------------------------------------------------

export type ProgramRow = {
  id: string
  user_id: string
  lead_id: string | null
  client_name: string
  client_email: string
  client_timezone: string | null
  program_name: string
  total_weeks: number
  sessions_allowed: number
  start_date: string // YYYY-MM-DD
  status: 'draft' | 'active' | 'completed' | 'paused' | 'canceled'
  portal_token_version: number
  portal_last_opened_at: string | null
  activated_at: string | null
  completed_at: string | null
}

export type ItemRow = {
  id: string
  kind: 'week' | 'task' | 'milestone'
  sequence_position: number
  source_week: number | null
  sort_order: number
  title: string
  detail: string | null
  phase_name: string | null
  due_date: string | null // YYYY-MM-DD
  status: 'pending' | 'completed'
  completed_at: string | null
  completed_by: 'coach' | 'client' | null
}

export type NoteRow = {
  id: string
  body: string
  visibility: 'coach_only' | 'coach_and_client'
  created_at: string
}

export type SessionRequestRow = {
  id: string
  item_id: string | null
  note: string | null
  preferred_1: string | null
  preferred_2: string | null
  status: 'requested' | 'confirmed' | 'declined' | 'withdrawn'
  booking_id: string | null
  decline_reason: string | null
  created_at: string
  resolved_at: string | null
  // The linked booking, when one exists. due_date is a `date` and carries no
  // time of day, so this is the ONLY source of a call's clock time (§8.3).
  booking: { start_time: string; end_time: string | null } | null
}

// Only what sessions_used needs. `canceled_at` is nullable on every row written
// before 094 and that is load-bearing below.
export type ProgramBookingRow = {
  id: string
  status: string
  start_time: string
  canceled_at: string | null
}

// ---------------------------------------------------------------------------
// Derived values (§9)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
// An overdue item alone is not stalled — a client can be a day late. Nothing
// finished in this long, WITH something overdue, is.
export const STALLED_AFTER_DAYS = 10

// Whole days between two YYYY-MM-DD dates, in UTC.
//
// Parsed as UTC midnight rather than through local Date parsing: `new Date('2026-08-07')`
// is UTC midnight but `new Date('2026/08/07')` is local, and a serializer whose
// week number depends on the server's zone would put a client in a different
// week depending on which region the lambda woke up in.
function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const a = Date.parse(`${fromYmd}T00:00:00Z`)
  const b = Date.parse(`${toYmd}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.floor((b - a) / DAY_MS)
}

/**
 * Which week of THEIR programme the client is in — a POSITION, never a
 * source_week. A client who starts at their coach's week 4 is in position 1,
 * and reporting 4 would tell them they are three weeks behind on their first day.
 *
 * NULL while `draft`: a draft has not started, so it has no current week, and
 * returning 1 would claim it had.
 *
 * `today` is supplied by the caller rather than read from the clock here, so the
 * zone decision is made where the client's timezone is known and this stays
 * deterministic.
 */
export function currentWeek(program: Pick<ProgramRow, 'status' | 'start_date' | 'total_weeks'>, today: string): number | null {
  if (program.status === 'draft') return null
  const elapsed = daysBetweenYmd(program.start_date, today)
  if (elapsed === null) return null
  const week = Math.floor(elapsed / 7) + 1
  return Math.min(Math.max(week, 1), Math.max(1, program.total_weeks))
}

/**
 * Progress over the things the client actually DOES — `task` and `milestone`.
 *
 * `week` rows are headings, not work (§6.1: the milestone is the week's work),
 * so counting them would dilute every programme by exactly the number of weeks
 * in it and no client would ever reach 100%.
 */
export function progressCounts(items: ItemRow[]): { items_total: number; items_completed: number; progress_pct: number } {
  const actionable = items.filter((i) => i.kind === 'task' || i.kind === 'milestone')
  const total = actionable.length
  const completed = actionable.filter((i) => i.status === 'completed').length
  return {
    items_total: total,
    items_completed: completed,
    // 0 of 0 is 0%, not NaN and not 100%. A programme with nothing in it has
    // made no progress; claiming it is complete would mark it done on creation.
    progress_pct: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

/**
 * A SESSION IS CONSUMED UNLESS IT WAS ACTIVELY GIVEN BACK.
 *
 * Three things this deliberately does NOT do:
 *
 * 1. `attended` is not in the formula. Every production booking is unmarked, so
 *    charging only for a marked no-show would hand a coach who never marks
 *    attendance an unlimited allowance.
 * 2. MANAGE_CUTOFF_MS is imported, not restated. The window a client may cancel
 *    in and the window that returns their session are the same window by
 *    construction — two copies would drift and the client would lose the
 *    difference.
 * 3. A NULL `canceled_at` counts as LATE. Rows cancelled before 094 have no
 *    timestamp, and "unknown" must not silently become "in good time". Charging
 *    is the safe direction: the coach can give a session back, but a client who
 *    was under-charged has already had the call.
 */
export function sessionsUsed(bookings: ProgramBookingRow[]): number {
  return bookings.filter((b) => {
    if (b.status !== 'canceled') return true
    if (!b.canceled_at) return true // unknown when — treated as late
    const start = Date.parse(b.start_time)
    const canceled = Date.parse(b.canceled_at)
    if (!Number.isFinite(start) || !Number.isFinite(canceled)) return true
    // Given back in good time -> not consumed.
    return !(canceled <= start - MANAGE_CUTOFF_MS)
  }).length
}

/**
 * Something is overdue AND nothing has moved in a while.
 *
 * Both halves are required. An overdue item on its own is a client who is a day
 * late; ten quiet days on their own is a client between weeks. Together they are
 * a programme that has stopped, which is the only state worth interrupting a
 * coach about.
 */
export function isStalled(items: ItemRow[], today: string): boolean {
  const hasOverdue = items.some(
    (i) => (i.kind === 'task' || i.kind === 'milestone') && i.status === 'pending' && !!i.due_date && i.due_date < today
  )
  if (!hasOverdue) return false

  const completions = items
    .map((i) => (i.status === 'completed' ? Date.parse(i.completed_at || '') : NaN))
    .filter((t) => Number.isFinite(t)) as number[]

  const todayMs = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(todayMs)) return false
  // Nothing has EVER been completed and something is overdue: stalled.
  if (!completions.length) return true
  return todayMs - Math.max(...completions) >= STALLED_AFTER_DAYS * DAY_MS
}

// ---------------------------------------------------------------------------
// Coach-facing serializers
// ---------------------------------------------------------------------------

export type ProgramSummaryInput = {
  program: ProgramRow
  items: ItemRow[]
  bookings: ProgramBookingRow[]
  openSessionRequests: number
  today: string
}

/**
 * One row of the coach's programme list.
 *
 * `next_item` is the single soonest pending piece of work, and it is NOT what
 * "Due this week" is folded from — that is a list-level aggregate across every
 * active programme, and one item per programme cannot produce it. Computed by
 * the endpoint, not here, so the distinction cannot be lost in a map().
 */
export function serializeProgramSummary(input: ProgramSummaryInput) {
  const { program, items, bookings, openSessionRequests, today } = input
  const used = sessionsUsed(bookings)
  const next = nextPendingItem(items)
  return {
    id: program.id,
    client_name: program.client_name,
    client_email: program.client_email,
    program_name: program.program_name,
    status: program.status,
    start_date: program.start_date,
    activated_at: program.activated_at,
    completed_at: program.completed_at,
    total_weeks: program.total_weeks,
    current_week: currentWeek(program, today),
    ...progressCounts(items),
    sessions_allowed: program.sessions_allowed,
    sessions_used: used,
    sessions_remaining: Math.max(0, program.sessions_allowed - used),
    open_session_requests: openSessionRequests,
    portal_last_opened_at: program.portal_last_opened_at,
    next_item: next ? { id: next.id, title: next.title, due_date: next.due_date } : null,
    is_stalled: isStalled(items, today),
  }
}

// Soonest due date wins; an undated item is only a candidate when nothing dated
// is pending, and then position order decides. Ties break on sequence_position
// then sort_order, so the answer is stable rather than dependent on row order.
function nextPendingItem(items: ItemRow[]): ItemRow | null {
  const pending = items.filter((i) => (i.kind === 'task' || i.kind === 'milestone') && i.status === 'pending')
  if (!pending.length) return null
  const dated = pending.filter((i) => !!i.due_date)
  const pool = dated.length ? dated : pending
  return pool.slice().sort((a, b) => {
    const d = String(a.due_date || '').localeCompare(String(b.due_date || ''))
    if (d !== 0) return d
    if (a.sequence_position !== b.sequence_position) return a.sequence_position - b.sequence_position
    return a.sort_order - b.sort_order
  })[0]
}

export type ProgramDetailInput = ProgramSummaryInput & {
  notes: NoteRow[]
  sessionRequests: SessionRequestRow[]
  portalUrl: string
  /**
   * Calls this client had with this coach BEFORE the programme — bookings for
   * (coach_user_id, client_email) with program_id null.
   *
   * THE SAME (coach, email) MATCH THE SCHEMA CALLS A TRAP, used deliberately
   * here and nowhere else. The asymmetry is the whole point: a wrong match here
   * shows a slightly wrong number in one sentence of UI, while a wrong match in
   * sessions_used takes away a call the client paid for. Same query, opposite
   * consequences — it must never migrate into the allowance calculation, which
   * counts by program_id and nothing else.
   */
  discoveryCallCount: number
}

/** The coach's view of one programme. Notes at BOTH visibilities — this is the coach path. */
export function serializeProgramDetail(input: ProgramDetailInput) {
  return {
    program: {
      ...serializeProgramSummary(input),
      client_timezone: input.program.client_timezone,
      portal_url: input.portalUrl,
    },
    items: input.items.map(serializeItem),
    notes: input.notes.map((n) => ({ id: n.id, body: n.body, visibility: n.visibility, created_at: n.created_at })),
    session_requests: input.sessionRequests.map((r) => ({
      id: r.id,
      note: r.note,
      preferred_1: r.preferred_1,
      preferred_2: r.preferred_2,
      status: r.status,
      booking_id: r.booking_id,
      decline_reason: r.decline_reason,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      booking: r.booking ? { start_time: r.booking.start_time, end_time: r.booking.end_time } : null,
    })),
    discovery_call_count: input.discoveryCallCount,
  }
}

function serializeItem(i: ItemRow) {
  return {
    id: i.id,
    kind: i.kind,
    sequence_position: i.sequence_position,
    source_week: i.source_week,
    sort_order: i.sort_order,
    title: i.title,
    detail: i.detail,
    phase_name: i.phase_name,
    due_date: i.due_date,
    status: i.status,
    completed_at: i.completed_at,
    completed_by: i.completed_by,
  }
}

// ---------------------------------------------------------------------------
// The client's portal
// ---------------------------------------------------------------------------

export const UPCOMING_LIMIT = 5

export type ClientPortalInput = {
  program: ProgramRow
  items: ItemRow[]
  bookings: ProgramBookingRow[]
  notes: NoteRow[]
  sessionRequests: SessionRequestRow[]
  today: string
  /** The coach's FIRST name, for an ad-hoc call with no linked item (§8.3). */
  coachFirstName: string
  /**
   * Brand tokens, passed through UNCHANGED. This module does not own that shape
   * and must not reshape it — lib/brandKit.ts is its one producer, so a token
   * renamed there reaches the portal without an edit here.
   */
  brand: Record<string, unknown>
}

/**
 * What the CLIENT sees. The interesting part of this function is what it does
 * not return.
 *
 * Never: user_id, lead_id, program_snapshot, portal_token_version, client_email,
 * a coach_only note, or anything belonging to another programme. Those are not
 * omitted by filtering a wider object — the shape is built key by key, so a new
 * column on client_programs cannot appear here by being added upstream.
 */
export function serializeClientPortal(input: ClientPortalInput) {
  const { program, items, bookings, notes, sessionRequests, today, coachFirstName, brand } = input
  const used = sessionsUsed(bookings)
  const week = currentWeek(program, today)

  return {
    program: {
      client_name: program.client_name,
      program_name: program.program_name,
      current_week: week,
      total_weeks: program.total_weeks,
      progress_pct: progressCounts(items).progress_pct,
      sessions_allowed: program.sessions_allowed,
      sessions_used: used,
      sessions_remaining: Math.max(0, program.sessions_allowed - used),
    },
    brand,
    this_week: thisWeek(items, week),
    upcoming: upcoming(items, sessionRequests, coachFirstName),
    phases: phases(items, week),
    // CLIENT-VISIBLE NOTES ONLY. A note written coach_only was written under a
    // different audience and the coach cannot retroactively consent to sharing
    // it; visibility is immutable after insert for the same reason.
    notes: notes
      .filter((n) => n.visibility === 'coach_and_client')
      .map((n) => ({ id: n.id, body: n.body, created_at: n.created_at })),
    open_request: openRequest(sessionRequests),
  }
}

/**
 * The client's current position, as one block.
 *
 * The `week` row at that position supplies the heading; the `task`/`milestone`
 * rows at the same position are its items. Every position has a week row, so
 * there is no such thing as a milestone-only position — a renderer that assumes
 * otherwise is reading a shape the mapping never produces.
 */
function thisWeek(items: ItemRow[], week: number | null) {
  if (week === null) return null
  const atPosition = items.filter((i) => i.sequence_position === week)
  const weekRow = atPosition.find((i) => i.kind === 'week') || null
  const inner = atPosition
    .filter((i) => i.kind !== 'week')
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
  if (!weekRow && !inner.length) return null
  return {
    sequence_position: week,
    // Their coach's week number, never renumbered — so the portal can say
    // "week 4 of your coach's method" while showing it as the client's week 1.
    source_week: weekRow?.source_week ?? null,
    phase_name: weekRow?.phase_name ?? null,
    title: weekRow?.title ?? null,
    detail: weekRow?.detail ?? null,
    items: inner.map((i) => ({ id: i.id, kind: i.kind, title: i.title, detail: i.detail, due_date: i.due_date, status: i.status })),
  }
}

/**
 * The next few things, items and calls interleaved in time.
 *
 * AN ITEM WITH A CONFIRMED CALL APPEARS ONCE, AS THE CALL — never twice. The
 * item carries a `due_date`, which is a date with no time of day; the call
 * carries the actual instant. Emitting both would show the same commitment
 * twice, once with a made-up midnight.
 */
function upcoming(items: ItemRow[], requests: SessionRequestRow[], coachFirstName: string) {
  const confirmed = requests.filter((r) => r.status === 'confirmed' && r.booking?.start_time)
  const claimedItemIds = new Set(confirmed.map((r) => r.item_id).filter(Boolean) as string[])

  const entries: { type: 'item' | 'session'; title: string; at: string; sequence_position?: number }[] = []

  for (const i of items) {
    if (i.kind === 'week' || i.status !== 'pending' || !i.due_date) continue
    if (claimedItemIds.has(i.id)) continue
    entries.push({ type: 'item', title: i.title, at: i.due_date, sequence_position: i.sequence_position })
  }

  for (const r of confirmed) {
    const linked = r.item_id ? items.find((i) => i.id === r.item_id) : undefined
    entries.push({
      type: 'session',
      // The linked item's title, or a plain label. Never a fabricated week
      // number for a call the client asked for out of band.
      title: linked ? linked.title : `Call with ${coachFirstName}`,
      at: r.booking!.start_time,
      ...(linked ? { sequence_position: linked.sequence_position } : {}),
    })
  }

  // A date sorts against a timestamp by treating it as that day's UTC midnight,
  // so `2026-08-14` and `2026-08-14T14:00:00Z` order correctly against each other.
  const sortKey = (at: string) => (at.length === 10 ? `${at}T00:00:00Z` : at)
  return entries
    .slice()
    .sort((a, b) => sortKey(a.at).localeCompare(sortKey(b.at)))
    .slice(0, UPCOMING_LIMIT)
}

/**
 * The phase rail, in the CLIENT's order.
 *
 * Ordered by first appearance by `sequence_position`, not by snapshot order: a
 * resequenced client sees their own journey, and reading source_week here would
 * show them their coach's.
 */
function phases(items: ItemRow[], week: number | null) {
  const byPosition = items.slice().sort((a, b) => a.sequence_position - b.sequence_position || a.sort_order - b.sort_order)
  const seen = new Map<string, { phase_name: string; first_position: number; last_position: number }>()
  for (const i of byPosition) {
    const name = i.phase_name
    if (!name) continue
    const existing = seen.get(name)
    if (!existing) seen.set(name, { phase_name: name, first_position: i.sequence_position, last_position: i.sequence_position })
    else existing.last_position = Math.max(existing.last_position, i.sequence_position)
  }
  return [...seen.values()].map((p) => ({
    ...p,
    state: week === null ? 'upcoming' : week > p.last_position ? 'done' : week >= p.first_position ? 'current' : 'upcoming',
  }))
}

// At most one open request exists at a time — a partial unique index enforces
// it, so this cannot quietly pick one of several.
function openRequest(requests: SessionRequestRow[]) {
  const open = requests.find((r) => r.status === 'requested')
  return open ? { id: open.id, note: open.note, preferred_1: open.preferred_1, preferred_2: open.preferred_2, created_at: open.created_at } : null
}
