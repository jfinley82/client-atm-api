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
  resend_message_id: string | null
}

type Tally = {
  sent: number
  delivered: number
  bounced: number
  complained: number
  opened: number
  clicked: number
  queued: number
  canceled: number
  messageIds: Set<string>
  openedIds: Set<string>
  clickedIds: Set<string>
}

function emptyTally(): Tally {
  return {
    sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, queued: 0, canceled: 0,
    messageIds: new Set(), openedIds: new Set(), clickedIds: new Set(),
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

function emailHealth(totals: EmailTotals): { score: number; delivered_rate: number; open_rate: number; click_rate: number; spam_rate: number } {
  const basis = totals.delivered > 0 ? totals.delivered : totals.sent
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
        .select('kind, status, scheduled_at, sent_at, delivered_at, bounced_at, complained_at, resend_message_id')
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

    for (const raw of (sendsRes.data || []) as SendRow[]) {
      const kind = typeof raw.kind === 'string' ? raw.kind : ''
      if (!kind || EXCLUDED_KINDS.has(kind)) continue
      const t = get(kind)
      if (raw.resend_message_id) t.messageIds.add(raw.resend_message_id)

      // 'canceled' means it never went out (the lead booked, unsubscribed, or
      // bounced first). Counting it as sent would understate every rate.
      if (raw.status === 'canceled') { t.canceled++; continue }

      // Still waiting on its scheduled time — real, but not yet a send.
      const dispatched = !!raw.sent_at || !!raw.delivered_at || raw.status === 'sent' || raw.status === 'failed'
      if (!dispatched) { t.queued++; continue }

      t.sent++
      if (raw.delivered_at) t.delivered++
      if (raw.bounced_at || raw.status === 'failed') t.bounced++
      // Complaints require prior delivery — never overlaps with a bounce (see
      // the resend webhook's split of the two).
      if (raw.complained_at) t.complained++
    }

    // Opens are deduped to one event per message by a partial unique index (048),
    // so counting rows gives unique opens. Clicks are deliberately NOT deduped, so
    // count distinct message ids for unique clickers and rows for total clicks.
    let totalClicks = 0
    for (const ev of (eventsRes.data || []) as { event_type: string; metadata: Record<string, unknown> | null }[]) {
      const meta = ev.metadata || {}
      const kind = typeof meta.kind === 'string' ? meta.kind : ''
      const messageId = typeof meta.resend_message_id === 'string' ? meta.resend_message_id : ''
      if (!kind || EXCLUDED_KINDS.has(kind)) continue
      const t = get(kind)
      if (ev.event_type === 'email_opened') {
        t.opened++
        if (messageId) t.openedIds.add(messageId)
      } else {
        totalClicks++
        t.clicked++
        if (messageId) t.clickedIds.add(messageId)
      }
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
      // Unique clickers, not raw clicks — one lead clicking three links is one
      // click-through, which is what a click rate means. Falls back to the raw
      // count only if no event carried a message id to dedupe on.
      const uniqueClicked = t.clickedIds.size > 0 ? t.clickedIds.size : t.clicked
      const basis = t.delivered > 0 ? t.delivered : t.sent
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
        opened: t.opened,
        clicked: uniqueClicked,
        total_clicks: t.clicked,
        delivered_pct: pct(t.delivered, t.sent),
        open_pct: pct(t.opened, basis),
        click_pct: pct(uniqueClicked, basis),
        bounce_pct: pct(t.bounced, t.sent),
        // Which denominator the two engagement rates used, so the tab can say so
        // instead of implying a precision the data does not have.
        rate_basis: t.delivered > 0 ? 'delivered' : 'sent',
      }
    })

    const totals = emails.reduce(
      (acc, e) => ({
        sent: acc.sent + e.sent,
        delivered: acc.delivered + e.delivered,
        bounced: acc.bounced + e.bounced,
        complained: acc.complained + e.complained,
        opened: acc.opened + e.opened,
        clicked: acc.clicked + e.clicked,
        queued: acc.queued + e.queued,
      }),
      { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, queued: 0 }
    )
    const totalBasis = totals.delivered > 0 ? totals.delivered : totals.sent

    return res.status(200).json({
      emails,
      totals: {
        ...totals,
        total_clicks: totalClicks,
        delivered_pct: pct(totals.delivered, totals.sent),
        open_pct: pct(totals.opened, totalBasis),
        click_pct: pct(totals.clicked, totalBasis),
        bounce_pct: pct(totals.bounced, totals.sent),
        rate_basis: totals.delivered > 0 ? 'delivered' : 'sent',
      },
      // Health rollup — same 0-100 percent scale as every other rate in this
      // response ("_pct"/"_rate" above), just documented once here rather than
      // per field. The frontend displays these; it never computes them.
      health: emailHealth(totals),
    })
  } catch (err) {
    console.error('[funnels/[id]/emails] GET', err)
    return res.status(500).json({ error: 'Failed to load email analytics' })
  }
}
