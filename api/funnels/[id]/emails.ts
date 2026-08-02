import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'

// GET /api/funnels/[id]/emails — per-email performance for the workspace's Emails
// tab. Owner-scoped.
//
// Two sources, joined on `kind`:
//   funnel_email_sends  — one row per email we handed to Resend, plus the
//     delivery state its webhook stamps back (sent_at / delivered_at / bounced_at).
//   funnel_events       — 'email_opened' / 'email_clicked', written by the same
//     webhook with metadata.kind, so engagement lines up with the send rows
//     without a second join key.
//
// Rates divide by DELIVERED, which is what email reporting means by open and
// click rate — an email that bounced was never a chance to be opened. Before the
// delivered webhook has stamped anything (older sends, or the event not yet
// subscribed in Resend) delivered is 0, and dividing by it would report 0% for
// emails that demonstrably got opened. So the basis falls back to sent and the
// response says which it used, rather than quietly showing a wrong number.
export const config = { maxDuration: 30 }

// The full set the tab lists, in send order, so an email the coach has never sent
// still appears as a zero row instead of vanishing.
//
// sequence_number/interval_label mirror the FIXED offsets lib/funnelNurture.ts
// actually schedules each kind at (NURTURE_OFFSETS/BOOK_A_CALL_OFFSETS/
// POST_CALL_OFFSETS, and the reminder times in scheduleBookingReminders) — kept
// in sync by hand since the schedule is a small, static design choice, not a
// per-send DB value. If that schedule ever changes, this table must change with
// it.
const KNOWN_KINDS: { kind: string; label: string; group: string; sequence_number: number; interval_label: string }[] = [
  { kind: 'nurture_1', label: 'Nurture 1', group: 'nurture', sequence_number: 1, interval_label: 'Immediately' },
  { kind: 'nurture_2', label: 'Nurture 2', group: 'nurture', sequence_number: 2, interval_label: '1 day later' },
  { kind: 'nurture_3', label: 'Nurture 3', group: 'nurture', sequence_number: 3, interval_label: '3 days later' },
  { kind: 'book_a_call_1', label: 'Book a call 1', group: 'book_a_call', sequence_number: 1, interval_label: 'Immediately' },
  { kind: 'book_a_call_2', label: 'Book a call 2', group: 'book_a_call', sequence_number: 2, interval_label: '2 days later' },
  { kind: 'book_a_call_3', label: 'Book a call 3', group: 'book_a_call', sequence_number: 3, interval_label: '4 days later' },
  { kind: 'booking_confirmation', label: 'Booking confirmation', group: 'booking', sequence_number: 1, interval_label: 'Immediately' },
  { kind: 'reminder_24h', label: 'Reminder — 24 hours', group: 'booking', sequence_number: 2, interval_label: '24 hours before the call' },
  { kind: 'reminder_1h', label: 'Reminder — 1 hour', group: 'booking', sequence_number: 3, interval_label: '1 hour before the call' },
  { kind: 'post_call_1', label: 'Post-call 1', group: 'post_call', sequence_number: 1, interval_label: 'Immediately' },
  { kind: 'post_call_2', label: 'Post-call 2', group: 'post_call', sequence_number: 2, interval_label: '1 day later' },
  { kind: 'post_call_3', label: 'Post-call 3', group: 'post_call', sequence_number: 3, interval_label: '4 days later' },
]

// Sent to the COACH, not the lead. Counting it alongside lead emails would put a
// guaranteed-open internal notification into the funnel's open rate.
const EXCLUDED_KINDS = new Set(['coach_booking_notification'])

type SendRow = {
  kind: string
  status: string
  scheduled_at: string | null
  sent_at: string | null
  delivered_at: string | null
  bounced_at: string | null
  complained_at: string | null
  opened_at: string | null
  clicked_at: string | null
  open_count: number | null
  click_count: number | null
  resend_message_id: string | null
}

// Engagement is tallied TWICE, against the two possible denominators, because a
// rate is only meaningful when its numerator is drawn from the same rows as its
// basis. Counting every open ever recorded over just the delivery-stamped sends
// is what produced 8 opens / 1 delivered = 800% on live data.
//
// `stamped` is the engagement denominator and is deliberately NARROWER than
// `sent`: only a row carrying a real sent_at/delivered_at from the delivery
// webhook counts. A row we marked 'sent' ourselves at hand-off time, or one
// still 'queued' that nevertheless has an open against it, is left out — see
// the rate note where the basis is chosen.
type Tally = {
  sent: number
  stamped: number
  delivered: number
  bounced: number
  complained: number
  queued: number
  canceled: number
  openedAmongStamped: number
  openedAmongDelivered: number
  clickedAmongStamped: number
  clickedAmongDelivered: number
  totalOpens: number
  totalClicks: number
}

function emptyTally(): Tally {
  return {
    sent: 0, stamped: 0, delivered: 0, bounced: 0, complained: 0, queued: 0, canceled: 0,
    openedAmongStamped: 0, openedAmongDelivered: 0, clickedAmongStamped: 0, clickedAmongDelivered: 0,
    totalOpens: 0, totalClicks: 0,
  }
}

function pct(n: number, d: number): number | null {
  if (!d) return null
  return Math.round((n / d) * 1000) / 10
}

// A null rate (no denominator yet — nothing sent/delivered) contributes
// nothing to the score rather than being read as 0%, so a funnel that hasn't
// sent anything yet doesn't score as if it had a terrible track record.
function rateOrZero(v: number | null): number {
  return v === null ? 0 : v
}

type EmailTotals = { sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number }

// Health score: a 0-100 weighted rollup of deliverability, engagement, and
// spam complaints, so the frontend only ever displays a number this backend
// already decided. "Delivered" means bounce-free delivery (email accepted by
// the receiving server), NOT inbox-folder placement — that isn't measurable
// from Resend's webhooks, so the label/field name says delivery, not inbox.
//
// Weights: deliverability is foundational (up to 50 pts) — a bad bounce rate
// poisons everything downstream. Opens (up to 30) and clicks (up to 20) are
// engagement, weighted by how deep the action is. Spam complaints are
// disproportionately punished (a real deliverability problem — mailbox
// providers throttle/block senders well below 1% complaints) relative to how
// small spam_rate numerically is: a 1% complaint rate (already bad) costs 15
// points, not a barely-visible fraction of one.
const SPAM_PENALTY_MULTIPLIER = 15

// `basis` is passed in rather than recomputed so the score divides by exactly
// the same denominator the response's open_pct/click_pct used — proven dispatch,
// not merely `sent`. Recomputing it here is how the two silently disagree.
function emailHealth(totals: EmailTotals, basis: number): { score: number; delivered_rate: number; open_rate: number; click_rate: number; spam_rate: number } {
  const delivered_rate = rateOrZero(pct(totals.delivered, totals.sent))
  const open_rate = rateOrZero(pct(totals.opened, basis))
  const click_rate = rateOrZero(pct(totals.clicked, basis))
  // Spam_rate's own denominator is DELIVERED specifically (a complaint can only
  // happen after delivery) — distinct from delivered_rate's sent-based basis.
  const spam_rate = rateOrZero(pct(totals.complained, totals.delivered))

  const raw =
    (delivered_rate / 100) * 50 +
    (open_rate / 100) * 30 +
    (click_rate / 100) * 20 -
    (spam_rate / 100) * 100 * SPAM_PENALTY_MULTIPLIER
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  return { score, delivered_rate, open_rate, click_rate, spam_rate }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const funnel = await getOwnedFunnel(userId, id, 'id')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  try {
    const [sendsRes, eventsRes] = await Promise.all([
      supabase
        .from('funnel_email_sends')
        .select('kind, status, scheduled_at, sent_at, delivered_at, bounced_at, complained_at, opened_at, clicked_at, open_count, click_count, resend_message_id')
        .eq('funnel_id', id),
      supabase
        .from('funnel_events')
        .select('event_type, metadata')
        .eq('funnel_id', id)
        .in('event_type', ['email_opened', 'email_clicked']),
    ])
    if (sendsRes.error) throw sendsRes.error
    if (eventsRes.error) throw eventsRes.error

    const tallies = new Map<string, Tally>()
    const get = (kind: string): Tally => {
      let t = tallies.get(kind)
      if (!t) { t = emptyTally(); tallies.set(kind, t) }
      return t
    }

    // Engagement recorded BEFORE migration 074 exists only as funnel_events rows,
    // so those are folded in by message id rather than dropped — every such event
    // was written only after its send row was resolved by that same id, so the
    // join is exact and no historical open is lost. Going forward the send row's
    // own opened_at/open_count is the authoritative source; keyed by message id,
    // the two never double-count the same send.
    const eventOpens = new Map<string, number>()
    const eventClicks = new Map<string, number>()
    for (const ev of (eventsRes.data || []) as { event_type: string; metadata: Record<string, unknown> | null }[]) {
      const messageId = typeof ev.metadata?.resend_message_id === 'string' ? ev.metadata.resend_message_id : ''
      if (!messageId) continue
      const target = ev.event_type === 'email_opened' ? eventOpens : eventClicks
      target.set(messageId, (target.get(messageId) || 0) + 1)
    }

    for (const raw of (sendsRes.data || []) as SendRow[]) {
      const kind = typeof raw.kind === 'string' ? raw.kind : ''
      if (!kind || EXCLUDED_KINDS.has(kind)) continue
      const t = get(kind)

      // 'canceled' means it never went out (the lead booked, unsubscribed, or
      // bounced first). Counting it as sent would understate every rate.
      if (raw.status === 'canceled') { t.canceled++; continue }

      const messageId = raw.resend_message_id || ''
      const legacyOpens = messageId ? eventOpens.get(messageId) || 0 : 0
      const legacyClicks = messageId ? eventClicks.get(messageId) || 0 : 0
      const opened = !!raw.opened_at || legacyOpens > 0
      const clicked = !!raw.clicked_at || legacyClicks > 0

      // Still waiting on its scheduled time — real, but not yet a send.
      // An open is deliberately NOT treated as evidence of dispatch here: a row
      // with no delivery stamp is a row we cannot prove went out, and inferring
      // dispatch from engagement would make every such row both a send and an
      // open, printing a 100% open rate off a backfill gap.
      const dispatched = !!raw.sent_at || !!raw.delivered_at || raw.status === 'sent' || raw.status === 'failed'
      if (!dispatched) { t.queued++; continue }

      t.sent++
      const delivered = !!raw.delivered_at
      if (delivered) t.delivered++
      if (raw.bounced_at || raw.status === 'failed') t.bounced++
      // Complaints require prior delivery — never overlaps with a bounce (see
      // the resend webhook's split of the two).
      if (raw.complained_at) t.complained++

      // The engagement denominator: a real stamp written by the delivery
      // webhook, never a status this app set on itself at hand-off.
      const stamped = !!raw.sent_at || !!raw.delivered_at
      if (stamped) t.stamped++

      // Opened/clicked at all — one send counts once however many times the
      // pixel fired, which is what an open/click RATE means. Only counted
      // against denominators this row is actually part of.
      if (opened) {
        if (stamped) t.openedAmongStamped++
        if (delivered) t.openedAmongDelivered++
      }
      if (clicked) {
        if (stamped) t.clickedAmongStamped++
        if (delivered) t.clickedAmongDelivered++
      }

      // Raw totals. max() rather than a sum: for a send stamped after 074 the
      // counter is authoritative, for a pre-074 send only the events exist, and
      // a send straddling the migration must not have its opens counted twice.
      t.totalOpens += Math.max(raw.open_count || 0, legacyOpens)
      t.totalClicks += Math.max(raw.click_count || 0, legacyClicks)
    }

    // Known kinds first in send order, then anything else that has data (a kind
    // added later still shows up rather than being silently dropped).
    const seen = new Set(KNOWN_KINDS.map((k) => k.kind))
    const rows = [
      ...KNOWN_KINDS,
      // A kind added later (no fixed schedule known here yet) still shows up
      // rather than being silently dropped — sequence_number/interval_label are
      // null rather than guessed.
      ...[...tallies.keys()]
        .filter((k) => !seen.has(k))
        .sort()
        .map((kind) => ({ kind, label: kind, group: 'other', sequence_number: null, interval_label: null })),
    ]

    const emails = rows.map((meta) => {
      const t = tallies.get(meta.kind) || emptyTally()
      // Whichever denominator this kind is using, the numerator is counted over
      // that SAME set of sends, so a rate can never exceed 100%.
      //
      // The basis is PROVEN dispatch — a real sent_at/delivered_at from the
      // delivery webhook — never merely `sent`. Sends predating that webhook
      // carry no stamp, so their basis is 0 and the rate is null, which the tab
      // renders "—". That is the honest answer: their opens are real but the
      // denominator is unknowable, and dividing by only the handful we can
      // account for would print a ~100% open rate off a backfill gap. Every new
      // send gets stamped, so this affects the historical gap only.
      const onDelivered = t.delivered > 0
      const basis = onDelivered ? t.delivered : t.stamped
      const opened = onDelivered ? t.openedAmongDelivered : t.openedAmongStamped
      const clicked = onDelivered ? t.clickedAmongDelivered : t.clickedAmongStamped
      return {
        kind: meta.kind,
        label: meta.label,
        group: meta.group,
        // This email's position within its sequence (1-indexed) and how long
        // after the trigger it sends — a fixed schedule, not a per-send value.
        sequence_number: meta.sequence_number,
        interval_label: meta.interval_label,
        sent: t.sent,
        delivered: t.delivered,
        bounced: t.bounced,
        complained: t.complained,
        queued: t.queued,
        canceled: t.canceled,
        // Sends that were opened / clicked at least once, within the basis set.
        opened,
        clicked,
        // Raw engagement events, which can exceed `opened`/`clicked` — one lead
        // reopening an email five times is five opens but one opened send.
        total_opens: t.totalOpens,
        total_clicks: t.totalClicks,
        delivered_pct: pct(t.delivered, t.sent),
        open_pct: pct(opened, basis),
        click_pct: pct(clicked, basis),
        bounce_pct: pct(t.bounced, t.sent),
        // Which denominator the two engagement rates used, so the tab can say so
        // instead of implying a precision the data does not have. null = no
        // provable dispatch to divide by, which is why the rate is "—".
        rate_basis: onDelivered ? 'delivered' : basis > 0 ? 'sent' : null,
      }
    })

    // Summed from the tallies, NOT from the per-email rows: each row already
    // picked its own basis, and adding those together would mix a sent-based
    // numerator into a delivered-based denominator — the same category error at
    // funnel level that this change fixes per email. The whole-funnel basis is
    // chosen once here, then its matching numerator is used.
    const grand = [...tallies.values()].reduce((acc, t) => {
      for (const k of Object.keys(acc) as (keyof Tally)[]) acc[k] += t[k]
      return acc
    }, emptyTally())
    const totalsOnDelivered = grand.delivered > 0
    const totalBasis = totalsOnDelivered ? grand.delivered : grand.stamped
    const totals = {
      sent: grand.sent,
      delivered: grand.delivered,
      bounced: grand.bounced,
      complained: grand.complained,
      queued: grand.queued,
      opened: totalsOnDelivered ? grand.openedAmongDelivered : grand.openedAmongStamped,
      clicked: totalsOnDelivered ? grand.clickedAmongDelivered : grand.clickedAmongStamped,
    }

    return res.status(200).json({
      emails,
      totals: {
        ...totals,
        total_opens: grand.totalOpens,
        total_clicks: grand.totalClicks,
        delivered_pct: pct(totals.delivered, totals.sent),
        open_pct: pct(totals.opened, totalBasis),
        click_pct: pct(totals.clicked, totalBasis),
        bounce_pct: pct(totals.bounced, totals.sent),
        rate_basis: totalsOnDelivered ? 'delivered' : totalBasis > 0 ? 'sent' : null,
      },
      // Health rollup — same 0-100 percent scale as every other rate in this
      // response ("_pct"/"_rate" above), just documented once here rather than
      // per field. The frontend displays these; it never computes them.
      health: emailHealth(totals, totalBasis),
    })
  } catch (err) {
    console.error('[funnels/[id]/emails] GET', err)
    return res.status(500).json({ error: 'Failed to load email analytics' })
  }
}
