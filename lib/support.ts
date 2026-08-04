// Support Desk shared vocabulary and SLA maths.
//
// Every endpoint that reports an SLA number imports from here. The breach rule
// appears ONCE so the KPI tile, the per-ticket age indicator, and the list view
// can never disagree about whether a given ticket is late — a red card above a
// green tile is worse than either number alone.

export const TICKET_CATEGORIES = ['account_billing', 'technical', 'funnel_builder', 'crm_leads', 'other'] as const
export const TICKET_STAGES = ['new', 'in_progress', 'waiting_on_member', 'escalated', 'resolved', 'closed'] as const
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export type TicketStage = (typeof TICKET_STAGES)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

// Stages that mean the ticket is off the queue. Everything else counts as open.
export const CLOSED_STAGES: readonly TicketStage[] = ['resolved', 'closed']

export const FIRST_RESPONSE_TARGET_MS = 24 * 60 * 60 * 1000
export const RESOLUTION_TARGET_MS = 72 * 60 * 60 * 1000

// What the MEMBER sees. The raw enum values are internal and must never appear
// in an email or anywhere member-facing.
export const STAGE_LABELS: Record<TicketStage, string> = {
  new: 'Received',
  in_progress: 'In progress',
  waiting_on_member: 'Waiting on you',
  escalated: 'With a specialist',
  resolved: 'Resolved',
  closed: 'Closed',
}

// Stage changes that earn an email. in_progress and escalated are internal
// bookkeeping — they render in the admin UI and would render on a member ticket
// history screen, they just don't generate mail. Mailing on every transition
// would train members to ignore the ones that actually ask something of them.
export const NOTIFY_STAGES: readonly TicketStage[] = ['waiting_on_member', 'resolved', 'closed']

export function isTicketStage(v: unknown): v is TicketStage {
  return typeof v === 'string' && (TICKET_STAGES as readonly string[]).includes(v)
}
export function isTicketPriority(v: unknown): v is TicketPriority {
  return typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v)
}
export function isTicketCategory(v: unknown): v is TicketCategory {
  return typeof v === 'string' && (TICKET_CATEGORIES as readonly string[]).includes(v)
}

export type TicketTimes = {
  created_at: string
  first_response_at: string | null
  resolved_at: string | null
}

const ms = (v: string | null | undefined): number | null => {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * First response is late when it either took longer than the target, or has not
 * happened yet and the target has already passed. Both halves matter: a ticket
 * sitting unanswered for 30h is breaching right now, and one answered at 30h
 * stays breached forever after.
 */
export function firstResponseLate(t: TicketTimes, now: number): boolean {
  const created = ms(t.created_at)
  if (created === null) return false
  const responded = ms(t.first_response_at)
  return responded === null ? now - created > FIRST_RESPONSE_TARGET_MS : responded - created > FIRST_RESPONSE_TARGET_MS
}

/** Same shape against the 72h resolution target. */
export function resolutionLate(t: TicketTimes, now: number): boolean {
  const created = ms(t.created_at)
  if (created === null) return false
  const resolved = ms(t.resolved_at)
  return resolved === null ? now - created > RESOLUTION_TARGET_MS : resolved - created > RESOLUTION_TARGET_MS
}

/**
 * A ticket breaches if EITHER target is missed, and counts ONCE even when both
 * are — the KPI is "how many tickets did we let down", not "how many targets
 * did we miss".
 */
export function isBreached(t: TicketTimes, now: number): boolean {
  return firstResponseLate(t, now) || resolutionLate(t, now)
}

/** Elapsed ms from creation to the first response, or null if none yet. */
export function firstResponseMs(t: TicketTimes): number | null {
  const created = ms(t.created_at)
  const responded = ms(t.first_response_at)
  return created === null || responded === null ? null : responded - created
}

/** Elapsed ms from creation to resolution, or null if unresolved. */
export function resolutionMs(t: TicketTimes): number | null {
  const created = ms(t.created_at)
  const resolved = ms(t.resolved_at)
  return created === null || resolved === null ? null : resolved - created
}

export function averageMs(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v !== null)
  if (!real.length) return null
  return Math.round(real.reduce((a, b) => a + b, 0) / real.length)
}

/** Whole days since creation — the age the card/row indicator shows. */
export function ageDays(createdAt: string, now: number): number {
  const created = ms(createdAt)
  if (created === null) return 0
  return Math.max(0, Math.floor((now - created) / (24 * 60 * 60 * 1000)))
}

/**
 * The per-ticket SLA block every list/detail response carries, so the frontend
 * colours an age indicator from `breached` rather than deciding for itself what
 * "looks old". A red card and a green tile can then never disagree.
 */
export function slaFor(t: TicketTimes, now: number) {
  return {
    breached: isBreached(t, now),
    first_response_late: firstResponseLate(t, now),
    resolution_late: resolutionLate(t, now),
    first_response_ms: firstResponseMs(t),
    resolution_ms: resolutionMs(t),
    age_days: ageDays(t.created_at, now),
  }
}

/**
 * Which timestamps a stage change stamps or clears.
 *
 * - Any move off `new`, when nothing has been answered yet, IS the first
 *   response — an admin who drags a card to In Progress has picked it up.
 * - `resolved` stamps resolved_at; moving back OUT of resolved clears it, so a
 *   reopened ticket does not keep a resolution time that no longer happened and
 *   silently score as on-time.
 * - `closed` deliberately does NOT stamp resolved_at: closing without resolving
 *   (duplicate, withdrawn) is not a resolution, and counting it as one would
 *   flatter the resolution-time average.
 */
export function stageTimestampUpdates(
  nextStage: TicketStage,
  current: { stage: string; first_response_at: string | null; resolved_at: string | null },
  nowIso: string
): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  if (nextStage !== 'new' && !current.first_response_at) updates.first_response_at = nowIso
  if (nextStage === 'resolved') {
    if (!current.resolved_at) updates.resolved_at = nowIso
  } else if (current.resolved_at) {
    updates.resolved_at = null
  }
  return updates
}
