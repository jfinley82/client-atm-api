import { supabase } from './supabase'

// Account-level contacts: one lead, everywhere it appears. Shared by
// GET /api/contacts (list), GET /api/contacts/[leadId] (detail) and
// POST /api/leads/[leadId]/outcome (which echoes a list-shaped row so the UI can
// patch in place). All three MUST agree on stage/last-activity, so the
// derivation lives here once rather than in each endpoint.

// The won pair. This is not a preference — it is what every revenue rollup
// already filters on (api/funnels/analytics.ts, api/funnels/portfolio.ts,
// api/funnels/[id]/analytics.ts all use .in('status', ['sold','closed'])).
// Recording a win writes 'sold', which those queries pick up unchanged.
export const WON_STATUSES = ['sold', 'closed'] as const
// Terminal not-won (migration 075). Deliberately outside WON_STATUSES.
export const LOST_STATUS = 'lost'

// One "Leads" stage by product decision — an opted-in contact that has done
// nothing further is still just a lead, so there is no separate opted_in stage
// and stage_counts carries no such key. opted_in_at is still read: it drives the
// "Opted in <date>" activity label below, which is about what HAPPENED, not
// about where the contact sits in the pipeline.
export type Stage = 'lead' | 'booked' | 'won' | 'nurture' | 'not_fit' | 'lost'
export const STAGES: Stage[] = ['lead', 'booked', 'won', 'nurture', 'not_fit', 'lost']

export type BookingRow = {
  id: string
  funnel_id: string | null
  email: string
  name: string | null
  start_time: string | null
  attended: string | null
  status: string | null
  zoom_join_url: string | null
  meeting_url: string | null
  custom_answers: unknown
  created_at: string | null
}

export type LeadRow = Record<string, any>

// bookings has no lead_id — it is matched on (funnel_id, email), the same join
// api/funnels/portfolio.ts uses. Email is normalized because a booking is taken
// from a form the lead retypes, so case can drift from the opt-in row.
export function bookingKey(funnelId: string | null | undefined, email: string | null | undefined): string {
  return `${funnelId || ''}::${(email || '').trim().toLowerCase()}`
}

const normEmail = (v: unknown): string => (typeof v === 'string' ? v : '').trim().toLowerCase()

/**
 * Which bookings belong to which contact — INCLUDING the ones that came through
 * the coach's own booking page.
 *
 * bookingKey needs a funnel id on both sides. A coach-page booking has
 * funnel_id NULL, so it keys as `::email` and can never equal a lead's
 * `funnelId::email`. The person shows up in the CRM fine — they became a lead
 * through the funnel — but their call does not attach to them. That is the
 * rebooking case exactly: someone who already came through the funnel is handed
 * the booking link so they need not reapply, and the resulting call is invisible
 * on the contact it belongs to.
 *
 * So a funnel-less booking matches on EMAIL ALONE, within the coach's own leads.
 * The caller must pass only leads and bookings it has already scoped to the
 * coach — this function does no ownership checking and must not be given a
 * wider set.
 *
 * ONE CALL, ONE CONTACT. The same address can be a lead in several funnels, and
 * attaching one call to all of them would show it two or three times and count
 * "booked" that many times in stage_counts. It attaches to the MOST RECENTLY
 * CREATED lead with that address, which is the same "most recent lead for this
 * email" rule api/calendar/book.ts already uses when it attributes a booking,
 * tie-broken on id so the choice is stable rather than dependent on row order.
 */
export function buildBookingIndex(
  leads: LeadRow[],
  bookings: BookingRow[]
): (lead: LeadRow) => BookingRow[] {
  const byFunnelKey = new Map<string, BookingRow[]>()
  const coachPageByEmail = new Map<string, BookingRow[]>()

  for (const b of bookings) {
    if (b.funnel_id) {
      const key = bookingKey(b.funnel_id, b.email)
      const list = byFunnelKey.get(key)
      if (list) list.push(b)
      else byFunnelKey.set(key, [b])
    } else {
      const key = normEmail(b.email)
      if (!key) continue
      const list = coachPageByEmail.get(key)
      if (list) list.push(b)
      else coachPageByEmail.set(key, [b])
    }
  }

  // Whichever lead owns the funnel-less calls for an address. Computed over
  // every lead, not only those with a booking, so the answer does not change
  // with which bookings happen to exist.
  const ownerByEmail = new Map<string, LeadRow>()
  for (const l of leads) {
    const key = normEmail(l.email)
    if (!key) continue
    const current = ownerByEmail.get(key)
    if (!current || isNewerLead(l, current)) ownerByEmail.set(key, l)
  }

  return (lead: LeadRow): BookingRow[] => {
    const funnelBookings = byFunnelKey.get(bookingKey(lead.funnel_id, lead.email)) || []
    const key = normEmail(lead.email)
    const owner = key ? ownerByEmail.get(key) : undefined
    if (!owner || owner.id !== lead.id) return funnelBookings
    return [...funnelBookings, ...(coachPageByEmail.get(key) || [])]
  }
}

// Newest created_at wins; ties broken on id so two leads created in the same
// millisecond still resolve to the same owner on every request.
function isNewerLead(candidate: LeadRow, current: LeadRow): boolean {
  const a = String(candidate.created_at || '')
  const b = String(current.created_at || '')
  if (a !== b) return a > b
  return String(candidate.id) > String(current.id)
}

// The lead's most recent ACTIVE booking. Canceled bookings do not make a lead
// "booked" — the slot was released and the lead is back in the pipeline.
export function pickBooking(bookings: BookingRow[]): BookingRow | null {
  const active = bookings.filter((b) => b.status !== 'canceled')
  if (!active.length) return null
  return active.slice().sort((a, b) => String(b.start_time || '').localeCompare(String(a.start_time || '')))[0]
}

// A booked call whose time has passed and that the coach never marked. This is
// the state the outcome write exists to clear, so it is surfaced as its own
// label rather than folded into "Call <date>".
export function needsOutcome(booking: BookingRow | null, now: number): boolean {
  if (!booking || !booking.start_time || booking.attended) return false
  return new Date(booking.start_time).getTime() < now
}

// Stage, first match wins.
//
// Note on 'not_fit': the gate writes funnel_leads.application_status
// ('applied'|'qualified'|'disqualified' — see api/funnel/application.ts).
// qualification_status is a separate, older column whose CHECK allows
// ('not_applicable'|'qualified'|'disqualified') and which is 'not_applicable'
// on every live row. Both are checked so neither path is missed.
export function deriveStage(lead: LeadRow, booking: BookingRow | null): Stage {
  const status = typeof lead.status === 'string' ? lead.status : ''
  if ((WON_STATUSES as readonly string[]).includes(status)) return 'won'
  if (status === LOST_STATUS) return 'lost'
  if (lead.application_status === 'disqualified' || lead.qualification_status === 'disqualified') return 'not_fit'
  if (booking) return 'booked'
  if (lead.nurture_pivoted === true) return 'nurture'
  // Opted in but nothing since — collapses into 'lead' rather than a stage of
  // its own.
  return 'lead'
}

function relative(at: string, now: number): string {
  const then = new Date(at).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.floor((now - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return ''
}

function shortDate(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// "Closed 2h ago" within a week, "Closed Jul 31" beyond it.
function stamp(verb: string, at: string, now: number): string {
  const rel = relative(at, now)
  return rel ? `${verb} ${rel}` : `${verb} ${shortDate(at)}`.trim()
}

export type LastActivity = { label: string; at: string | null }

// The single line the list shows per contact. Ordered by what a coach needs to
// see, not chronologically: an unmarked past call outranks everything because it
// is the one row that is asking them to do something.
export function lastActivity(
  lead: LeadRow,
  booking: BookingRow | null,
  stage: Stage,
  wonAt: string | null,
  latestVideo: { event_type: string; created_at: string } | null,
  now: number
): LastActivity {
  if (needsOutcome(booking, now)) return { label: 'Needs outcome', at: booking!.start_time }

  if (stage === 'won') {
    const at = wonAt || lead.application_submitted_at || lead.created_at || null
    return { label: at ? stamp('Closed', at, now) : 'Closed', at }
  }
  if (stage === 'lost') {
    const at = wonAt || lead.created_at || null
    return { label: 'Not closed', at }
  }
  // not_fit before booked, matching deriveStage's own precedence — otherwise a
  // disqualified lead who had already booked would read "Call Jul 31" while its
  // stage said not_fit, and the row would contradict itself.
  if (stage === 'not_fit') {
    return { label: 'Disqualified', at: lead.application_submitted_at || lead.created_at || null }
  }
  if (booking) {
    const at = booking.start_time
    if (booking.attended === 'showed') return { label: at ? `Showed ${shortDate(at)}` : 'Showed', at }
    if (booking.attended === 'no_show') return { label: at ? `No-show ${shortDate(at)}` : 'No-show', at }
    return { label: at ? `Call ${shortDate(at)}` : 'Call booked', at }
  }
  if (stage === 'nurture') {
    return { label: 'Moved to nurture', at: lead.opted_in_at || lead.created_at || null }
  }
  // A watched training outranks the bare opt-in when it happened after it.
  if (latestVideo && (!lead.opted_in_at || latestVideo.created_at > lead.opted_in_at)) {
    const label = latestVideo.event_type === 'video_completed' ? 'Watched to the end' : 'Watched the training'
    return { label, at: latestVideo.created_at }
  }
  if (lead.opted_in_at) return { label: stamp('Opted in', lead.opted_in_at, now), at: lead.opted_in_at }
  // Row exists but never opted in — captured, not yet engaged.
  return { label: 'Registered', at: lead.created_at || null }
}

// Human-readable funnel name. funnels has no `name` column; this mirrors the
// label -> landing_page.headline -> subdomain fallback api/funnels/portfolio.ts
// already uses so the same funnel reads the same everywhere.
export function funnelDisplayName(f: Record<string, any> | undefined | null): string {
  if (!f) return 'Unknown funnel'
  const label = typeof f.problem_solution_label === 'string' ? f.problem_solution_label.trim() : ''
  if (label) return label
  const headline = (f.landing_page && typeof f.landing_page === 'object' ? f.landing_page.headline : null) as unknown
  if (typeof headline === 'string' && headline.trim()) return headline.trim()
  if (typeof f.subdomain === 'string' && f.subdomain.trim()) return f.subdomain.trim()
  return 'Untitled funnel'
}

export function contactName(lead: LeadRow, booking: BookingRow | null): string | null {
  for (const v of [lead.name, lead.first_name, booking?.name]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

export type Contact = {
  lead_id: string
  name: string | null
  email: string
  source: string
  funnel_id: string
  stage: Stage
  value: number | null
  last_activity: LastActivity
  booking: { start_time: string | null; attended: 'yes' | 'no' | null }
}

// One list row. `booking.attended` is mapped to the yes|no|null the UI contract
// asks for; the column itself stores 'showed'|'no_show'|NULL, which is also the
// only vocabulary the write path may use (bookings_attended_check).
export function buildContact(
  lead: LeadRow,
  booking: BookingRow | null,
  funnel: Record<string, any> | undefined,
  wonAt: string | null,
  latestVideo: { event_type: string; created_at: string } | null,
  now: number
): Contact {
  const stage = deriveStage(lead, booking)
  const amount = lead.close_amount
  return {
    lead_id: lead.id,
    name: contactName(lead, booking),
    email: lead.email,
    source: funnelDisplayName(funnel),
    funnel_id: lead.funnel_id,
    stage,
    value: amount === null || amount === undefined ? null : Number(amount),
    last_activity: lastActivity(lead, booking, stage, wonAt, latestVideo, now),
    booking: {
      start_time: booking?.start_time ?? null,
      attended: booking?.attended === 'showed' ? 'yes' : booking?.attended === 'no_show' ? 'no' : null,
    },
  }
}

// Application answers rendered as Q/A. Labels come from the funnel's own
// booking_questions (the canonical question set — migration 070 dropped the
// normalized alternative), so a question renamed later still reads correctly
// against the id the answer was stored under. An answer whose question has since
// been deleted is kept with its raw id rather than dropped, so nothing a lead
// actually submitted disappears from the coach's view.
export function renderAnswers(answers: unknown, questions: unknown): { question: string; answer: string }[] {
  const qs = Array.isArray(questions) ? questions : []
  const labelById = new Map<string, string>()
  for (const q of qs) {
    if (q && typeof q === 'object' && typeof (q as any).id === 'string') {
      labelById.set((q as any).id, typeof (q as any).label === 'string' ? (q as any).label : (q as any).id)
    }
  }
  const out: { question: string; answer: string }[] = []
  const push = (id: string, raw: unknown) => {
    const answer = Array.isArray(raw) ? raw.join(', ') : raw === null || raw === undefined ? '' : String(raw)
    out.push({ question: labelById.get(id) || id, answer })
  }
  // Stored either as the validated array [{ id/question_id, label, answer }] the
  // booking path writes, or as a raw { [questionId]: value } map.
  if (Array.isArray(answers)) {
    for (const a of answers) {
      if (!a || typeof a !== 'object') continue
      const o = a as any
      const id = typeof o.id === 'string' ? o.id : typeof o.question_id === 'string' ? o.question_id : ''
      const label = typeof o.label === 'string' && o.label ? o.label : labelById.get(id) || id
      const raw = o.answer !== undefined ? o.answer : o.value
      out.push({ question: label, answer: Array.isArray(raw) ? raw.join(', ') : raw === null || raw === undefined ? '' : String(raw) })
    }
    return out
  }
  if (answers && typeof answers === 'object') {
    for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) push(id, raw)
  }
  return out
}

// The won/lost transition timestamp, read from the funnel_event the status
// change logs. funnel_leads has no closed_at column, so this event IS the
// record of when it happened.
export async function loadOutcomeTimes(leadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!leadIds.length) return out
  const { data } = await supabase
    .from('funnel_events')
    .select('lead_id, created_at')
    .in('lead_id', leadIds)
    .in('event_type', ['sold', 'closed'])
    .order('created_at', { ascending: false })
  for (const row of (data || []) as { lead_id: string; created_at: string }[]) {
    if (row.lead_id && !out.has(row.lead_id)) out.set(row.lead_id, row.created_at)
  }
  return out
}

export async function loadLatestVideo(leadIds: string[]): Promise<Map<string, { event_type: string; created_at: string }>> {
  const out = new Map<string, { event_type: string; created_at: string }>()
  if (!leadIds.length) return out
  const { data } = await supabase
    .from('funnel_events')
    .select('lead_id, event_type, created_at')
    .in('lead_id', leadIds)
    .in('event_type', ['video_watched', 'video_completed'])
    .order('created_at', { ascending: false })
  for (const row of (data || []) as { lead_id: string; event_type: string; created_at: string }[]) {
    if (row.lead_id && !out.has(row.lead_id)) out.set(row.lead_id, { event_type: row.event_type, created_at: row.created_at })
  }
  return out
}
