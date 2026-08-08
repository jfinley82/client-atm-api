import { isStalled, currentWeek, progressCounts, type ItemRow, type ProgramRow } from './clientProgramSerializers'

// The My Business dashboard payload, built from rows and nothing else.
//
// PURE, so scripts/served-contract.mjs can run the real thing over a synthetic
// probe and generate docs/served-contract.md from behaviour rather than from a
// hand-written list — the same mechanism the client-programs shapes use.
//
// COUNTS ARE OVER EVERYTHING; LISTS ARE TRUNCATED. "3 calls with no outcome"
// counts all three even though the panel shows one. Getting this backwards
// produces a dashboard that quietly under-reports as a coach grows, and every
// count below is computed from the full set before any slice happens.
//
// ZERO IS THE NORMAL FIRST STATE. A brand new coach has no funnels, no leads, no
// clients and no bookings; that response is as well-formed as a busy one. Where
// "nothing yet" and "not applicable" differ, they are different values —
// `method` is null for a coach who has not built one, which is not the same as a
// coach whose programmes are all complete.

export const CLIENT_LIST_LIMIT = 5
export const LEAD_LIST_LIMIT = 5
export const UPCOMING_LIMIT = 5
export const REQUEST_LIST_LIMIT = 5
/** The strip shows the highest-priority non-zero items, never a fixed set. */
export const ATTENTION_LIMIT = 4

const DAY_MS = 24 * 60 * 60 * 1000

// Priority order for the attention strip. FIRST is most urgent. Every entry is
// something to go and do; a statistic with no action does not belong here.
//
// Ordered by who is waiting and how much it costs to keep them waiting: a client
// who has asked for a call is waiting on the coach right now; a stalled client is
// paying and receiving nothing; an unclosed call is money already earned and not
// recorded; an approved lead who never booked is a sale in progress.
export const ATTENTION_ORDER = [
  'open_session_requests',
  'stalled_clients',
  'calls_needing_outcome',
  'approved_not_booked',
  'leads_no_activity',
  'programme_drafts',
  'calls_this_week',
  'funnels_in_draft',
] as const

export type AttentionKey = (typeof ATTENTION_ORDER)[number]
export type AttentionItem = { key: AttentionKey; count: number; detail: string | null }

/**
 * The strip: the highest-priority items that are NON-ZERO.
 *
 * Zero-count items are dropped rather than shown greyed, because the strip is a
 * work list — "0 stalled clients" is not work, and four zeroes on a new coach's
 * screen is noise where an empty state should be.
 */
export function attentionStrip(counts: Record<AttentionKey, number>, details: Partial<Record<AttentionKey, string | null>>): AttentionItem[] {
  return ATTENTION_ORDER.filter((key) => (counts[key] ?? 0) > 0)
    .slice(0, ATTENTION_LIMIT)
    .map((key) => ({ key, count: counts[key], detail: details[key] ?? null }))
}

/** "9 days ago" / "in 3 days" / "today" — one line of detail under a count. */
export function relativeDay(iso: string | null, nowMs: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const days = Math.round((t - nowMs) / DAY_MS)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days < 0 ? `${Math.abs(days)} days ago` : `in ${days} days`
}

export type DashboardFunnel = {
  id: string
  name: string
  status: string | null
  leads: number
  booked: number
}

/**
 * Book rate is FUNNEL-SCOPED BY DEFINITION.
 *
 * Bookings whose funnel_id is this funnel, over leads whose funnel_id is this
 * funnel. Nothing else. A coach-page booking has no funnel, so it cannot be
 * attributed to one, and attributing it anywhere would invent a source — the
 * per-funnel column would then depend on a call the funnel never produced.
 *
 * This is the same line api/funnels/portfolio.ts sits on, and it is why the
 * per-funnel counts do not sum to the coach's total. See callsReconciliation.
 */
export function bookRate(f: Pick<DashboardFunnel, 'leads' | 'booked'>): number {
  // 0 of 0 is 0%, not NaN and not 100%. A funnel nobody has reached has
  // converted nobody.
  return f.leads === 0 ? 0 : Math.round((f.booked / f.leads) * 100)
}

/**
 * THREE NUMBERS THAT MUST ADD UP, named so a reader can tell which question each
 * answers.
 *
 * The per-funnel column sums to LESS than the coach's total whenever a
 * coach-page booking exists — in production today that is every call the one
 * real coach owns, so the funnel column reads 0 against a headline of 1. A coach
 * who adds up the column and compares it to the headline would otherwise
 * conclude the dashboard is broken.
 *
 * It is not reconciled by changing either number. The remainder is carried
 * explicitly so the frontend can show a row rather than leave a hole.
 *
 * THE WINDOW IS ALL TIME, and all three share it. Book rate is an all-time ratio
 * (portfolio computes it over every lead and every booking), so its
 * reconciliation partner has to be too — a this-week total would add up
 * arithmetically against an all-time funnel column while meaning nothing.
 * "Calls booked this week" is a separate, separately-named attention count.
 *
 * ACTIVE ONLY, because loadOwnedActiveBookings filters status='active'. A
 * cancelled call is not on the coach's calendar and is not one of their calls.
 */
export function callsReconciliation(bookings: { funnel_id: string | null }[]) {
  const fromFunnels = bookings.filter((b) => b.funnel_id).length
  return {
    calls_total: bookings.length,
    calls_from_funnels: fromFunnels,
    calls_no_funnel: bookings.length - fromFunnels,
  }
}

export type DashboardClientInput = {
  program: ProgramRow
  items: ItemRow[]
  openRequests: number
}

/**
 * One row of the client list.
 *
 * Ordered: open request first (the client is waiting on the coach), then
 * stalled (paying and receiving nothing), then soonest due item. Drafts last —
 * a draft has not been sent, so nobody is waiting on anything.
 *
 * Insertion order would be a list nobody reads twice.
 */
export function serializeClients(inputs: DashboardClientInput[], today: string, limit = CLIENT_LIST_LIMIT) {
  const rows = inputs.map((c) => {
    const progress = progressCounts(c.items)
    const next = c.items
      .filter((i) => (i.kind === 'task' || i.kind === 'milestone') && i.status === 'pending' && !!i.due_date)
      .map((i) => i.due_date as string)
      .sort()[0] ?? null
    return {
      id: c.program.id,
      client_name: c.program.client_name,
      status: c.program.status,
      current_week: currentWeek(c.program, today),
      total_weeks: c.program.total_weeks,
      progress_pct: progress.progress_pct,
      is_stalled: isStalled(c.items, today),
      open_session_requests: c.openRequests,
      is_draft: c.program.status === 'draft',
      next_due_date: next,
    }
  })

  const rank = (r: (typeof rows)[number]) => {
    if (r.is_draft) return 3
    if (r.open_session_requests > 0) return 0
    if (r.is_stalled) return 1
    return 2
  }
  return rows
    .slice()
    .sort((a, b) => rank(a) - rank(b) || String(a.next_due_date ?? '9999').localeCompare(String(b.next_due_date ?? '9999')))
    .slice(0, limit)
}

/**
 * "Your method" — or null.
 *
 * NULL MEANS THEY HAVE NOT BUILT ONE, which is a different state from a coach
 * whose programmes are all complete, and the frontend renders a different empty
 * state for each. Returning zeroes here would collapse the two.
 */
export function serializeMethod(
  framework: Record<string, unknown> | null,
  counts: { blueprints: number; offers: number },
  bookingUrl: string | null
) {
  if (!framework) return null
  const phases = Array.isArray((framework as any).phases) ? (framework as any).phases : []
  const steps = phases.reduce((n: number, p: any) => n + (Array.isArray(p?.steps) ? p.steps.length : 0), 0)
  return {
    // Derived from the data, never a literal — the recorded defect in this repo
    // is a hardcoded count above a table of a different size.
    framework_name: typeof (framework as any).name === 'string' ? (framework as any).name : null,
    phase_count: phases.length,
    step_count: steps,
    blueprint_count: counts.blueprints,
    offer_count: counts.offers,
    // Nullable on funnel_business_settings, so a coach who has not set a slug
    // gets null rather than a URL with an empty segment in it.
    booking_url: bookingUrl,
  }
}
