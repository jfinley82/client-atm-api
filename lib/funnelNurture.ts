import { API_URL } from './appUrls'
import { supabase } from './supabase'
import { bookingTimeLabel } from './bookingTimezone'
import {
  CoachBrand,
  loadCoachBrand,
  brandedEmailHtml,
  composeEmailBody,
  scheduleFunnelEmail,
  cancelFunnelSends,
} from './email'
import { signWatchToken, signUnsubscribeToken } from './funnelLeadToken'

// A seeded nurture/book-a-call email. Same shape as the generator's MtEmail, but
// declared locally + coerced here so this (public, hot-path) module never pulls
// in microTrainingGenerator and its top-level Anthropic client.
type MtEmail = { email_number: number; send_timing: string; subject: string; body: string }

function coerceEmails(v: unknown): MtEmail[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      return {
        email_number: typeof o.email_number === 'number' && Number.isFinite(o.email_number) ? o.email_number : i + 1,
        send_timing: typeof o.send_timing === 'string' ? o.send_timing : '',
        subject: typeof o.subject === 'string' ? o.subject : '',
        body: typeof o.body === 'string' ? o.body : '',
      }
    })
    .filter((e) => e.subject.trim().length > 0 || e.body.trim().length > 0)
    .sort((a, b) => a.email_number - b.email_number)
}

// Funnel Builder Phase 5b — the event-driven nurture engine. It never runs on a
// cron: every future email is handed to Resend with a scheduledAt up front and
// CANCELED via resend.emails.cancel when an event (watch pivot, booked, closed,
// unsubscribe, bounce) makes it moot. All functions are best-effort and never
// throw — a scheduling hiccup must not break the opt-in / booking that triggered it.

// The domain public funnels actually serve on ({slug}.freeminiworkshop.com) —
// NOT microtrainingmethod.com, which is GHL and never routes to render, so links
// there are dead. Env-overridable; defaults to the live funnel domain.
const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

// Fixed slots, ms from the trigger moment. nurture: 1 now / 2 +1d / 3 +3d.
const NURTURE_OFFSETS = [0, 1 * DAY, 3 * DAY]
// book-a-call: 1 now / 2 +2d / 3 +4d.
const BOOK_A_CALL_OFFSETS = [0, 2 * DAY, 4 * DAY]
// post-call: 1 now (same-day recap) / 2 +1d / 3 +4d, measured from the moment
// attendance is marked rather than from the call's start time.
const POST_CALL_OFFSETS = [0, 1 * DAY, 4 * DAY]

// API_URL now has ONE owner — see lib/appUrls.ts. This was one of three
// identical copies, each defaulting to the raw Vercel deployment URL.

const NURTURE_SUBJECTS = ['Your training is ready', 'Did you get a chance to watch?', 'Last chance to watch the training']
const BOOK_SUBJECTS = ['Ready for the next step?', 'One quick thing', 'A final invitation']
const POST_CALL_SUBJECTS = ['Great speaking with you', 'Following up on our call', 'Still here when you are']

type Funnel = Record<string, any>

function publicBase(subdomain: string): string {
  return `https://${subdomain}.${FUNNEL_DOMAIN}`
}
// wt is the lead-scoped watch token. The invite broadcast has no lead, so it
// links to the plain training page — no attribution, rather than a fake lead.
function trainingUrl(subdomain: string, wt?: string): string {
  const base = `${publicBase(subdomain)}/?page=training`
  return wt ? `${base}&wt=${encodeURIComponent(wt)}` : base
}
function bookUrl(subdomain: string): string {
  return `${publicBase(subdomain)}/?page=book`
}

// The guide/download URL for [GUIDE_LINK] — the published PDF on the funnel's
// generation. Missing/unpublished ⇒ undefined, and [GUIDE_LINK] degrades to a
// plain word rather than leaking the literal token. Best-effort; never throws.
async function loadGuideUrl(funnel: Funnel): Promise<string | undefined> {
  const genId = funnel.generation_id
  if (typeof genId !== 'string' || !genId) return undefined
  try {
    const { data } = await supabase.from('mtm_generations').select('guide_url').eq('id', genId).maybeSingle()
    const url = (data as { guide_url?: unknown } | null)?.guide_url
    return typeof url === 'string' && url.trim() ? url.trim() : undefined
  } catch {
    return undefined
  }
}
function unsubscribeUrl(funnelId: string, leadId: string): string {
  return `${API_URL}/api/funnel/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(funnelId, leadId))}`
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
// Call reminders go to the LEAD, so they carry the lead's own zone when the
// booking captured one — the same rule as the confirmation email. Without it
// this rendered "11:30 PM (UTC)" for a call the visitor picked at 6:30 PM, a day
// before the call, which is the moment a no-show gets decided.
// bookingTimeLabel keeps the exact UTC wording when no zone was captured.

async function isUnsubscribed(leadId: string): Promise<boolean> {
  const { data } = await supabase.from('funnel_leads').select('email_unsubscribed').eq('id', leadId).maybeSingle()
  return data?.email_unsubscribed === true
}

// Schedule one MtEmail set (nurture or book-a-call). The CTA is computed per
// email from its own send time so a nurture email's ?wt= watch token is minted
// to be valid WHEN THAT EMAIL LANDS (a 24h token on a +3d email would be dead) —
// this is why watches from any nurture email still attribute and fire the pivot.
async function scheduleSet(opts: {
  funnel: Funnel
  brand: CoachBrand
  leadId: string
  to: string
  emails: MtEmail[]
  kindPrefix: 'nurture' | 'book_a_call' | 'post_call'
  offsets: number[]
  subdomain: string
  bookUrlForTokens: string
  guideUrl?: string
  defaultSubjects: string[]
  nowMs: number
  // Only the post-call set is tied to a booking; it is what lets the sequence be
  // canceled for that one call when attendance is corrected to no_show.
  bookingId?: string
}): Promise<void> {
  const unsub = unsubscribeUrl(opts.funnel.id as string, opts.leadId)
  const n = Math.min(opts.emails.length, opts.offsets.length)
  const tasks: Promise<unknown>[] = []
  for (let i = 0; i < n; i++) {
    const em = opts.emails[i]
    const sendTimeMs = opts.nowMs + opts.offsets[i]
    const kind = `${opts.kindPrefix}_${i + 1}`
    const subject = (em.subject && em.subject.trim()) || opts.defaultSubjects[i] || opts.defaultSubjects[opts.defaultSubjects.length - 1]

    // Per-email training URL carrying a watch token minted for THIS email's send
    // time — used for the nurture CTA and to substitute [TRAINING_LINK] in the
    // body (so a body-embedded training link still attributes + fires the pivot).
    const training = trainingUrl(opts.subdomain, signWatchToken(opts.funnel.id as string, opts.leadId, sendTimeMs))

    // The button is derived from the body's tokens (primary CTA = first
    // button-eligible token in reading order), NOT forced by the sequence:
    // every other token — including [GUIDE_LINK] — renders as an inline link.
    // `cta` is deliberately NOT passed to brandedEmailHtml: the button is
    // already inside bodyHtml, at the token's own position. Passing it would
    // render a second one below the signature.
    const { bodyHtml, cta, buttonRendered } = composeEmailBody(
      em.body,
      { book: opts.bookUrlForTokens, training, guide: opts.guideUrl },
      opts.brand.primaryColor
    )
    const html = brandedEmailHtml(opts.brand, {
      heading: subject,
      bodyHtml,
      ...(buttonRendered && cta ? { ctaFallbackUrl: cta.url } : {}),
      unsubscribeUrl: unsub,
    })
    const scheduledAt = opts.offsets[i] > 0 ? new Date(sendTimeMs).toISOString() : undefined

    tasks.push(
      scheduleFunnelEmail({
        brand: opts.brand,
        funnelId: opts.funnel.id as string,
        leadId: opts.leadId,
        kind,
        to: opts.to,
        subject,
        html,
        scheduledAt,
        ...(opts.bookingId ? { bookingId: opts.bookingId } : {}),
      })
    )
  }
  await Promise.all(tasks)
}

// Opt-in: schedule the nurture sequence (1 now, 2 +1d, 3 +3d). 2 and 3 are
// canceled by the pivot / suppression events if the lead acts first.
export async function scheduleNurtureSequence(funnel: Funnel, leadId: string, email: string, nowMs: number = Date.now()): Promise<void> {
  try {
    const subdomain = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
    if (!subdomain || !email) return
    if (await isUnsubscribed(leadId)) return
    const emails = coerceEmails(funnel.nurture_emails)
    if (!emails.length) return
    const [brand, guideUrl] = await Promise.all([loadCoachBrand(funnel.user_id as string), loadGuideUrl(funnel)])
    await scheduleSet({
      funnel,
      brand,
      leadId,
      to: email,
      emails,
      kindPrefix: 'nurture',
      offsets: NURTURE_OFFSETS,
      subdomain,
      bookUrlForTokens: bookUrl(subdomain),
      guideUrl,
      defaultSubjects: NURTURE_SUBJECTS,
      nowMs,
    })
  } catch (err) {
    console.error('[nurture] scheduleNurtureSequence', err)
  }
}

// Watch crossed the threshold: atomically claim the pivot (so concurrent
// crossings don't double-fire), cancel the remaining nurture queue, and schedule
// the book-a-call sequence (1 now, 2 +2d, 3 +4d).
export async function pivotToBookACall(funnel: Funnel, leadId: string, email: string, nowMs: number = Date.now()): Promise<void> {
  try {
    const subdomain = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
    if (!subdomain || !email) return

    // Compare-and-swap: only the first crossing flips the flag and proceeds.
    const { data: swapped } = await supabase
      .from('funnel_leads')
      .update({ nurture_pivoted: true })
      .eq('id', leadId)
      .eq('nurture_pivoted', false)
      .select('id')
    if (!swapped || !swapped.length) return

    // Stop the nurture track regardless of what happens next.
    await cancelNurtureQueue(leadId)

    if (await isUnsubscribed(leadId)) return
    const emails = coerceEmails(funnel.book_a_call_emails)
    if (!emails.length) return
    const [brand, guideUrl] = await Promise.all([loadCoachBrand(funnel.user_id as string), loadGuideUrl(funnel)])
    await scheduleSet({
      funnel,
      brand,
      leadId,
      to: email,
      emails,
      kindPrefix: 'book_a_call',
      offsets: BOOK_A_CALL_OFFSETS,
      subdomain,
      bookUrlForTokens: bookUrl(subdomain),
      guideUrl,
      defaultSubjects: BOOK_SUBJECTS,
      nowMs,
    })
  } catch (err) {
    console.error('[nurture] pivotToBookACall', err)
  }
}

// ── Booking reminders ────────────────────────────────────────────────────────
// ONE cadence for every booking, funnel or public: confirmation (sent by the
// booking handler) plus 1 week, 3 days, 24 hours and 1 hour before the call.
//
// Funnel bookings previously got 24h/1h only. Two cadences would have meant a
// reason for the difference that has to survive every future reader, and this
// codebase has already paid for one idea with two implementations — the 60/45/14
// availability window mess came from exactly that.
//
// There is no cron. scheduleFunnelEmail hands scheduledAt to Resend, which does
// the scheduling, and records a queued row carrying the Resend message id so
// cancelBookingReminders can stop it later.
// The minimum gap between the confirmation and a HORIZON reminder.
//
// A booking made 7.5 days out would otherwise get "your call is next week" about
// twelve hours after its confirmation — a system with no memory of the email it
// just sent. These two reminders say nothing except "this is still a while
// away", which is exactly the claim a fresh confirmation has already made.
//
// APPLIED PER REMINDER, not to the set, because a blanket gap does real damage.
// At 24 hours it would drop the 1-hour reminder for any booking made less than
// 25 hours ahead — someone booking a call for tomorrow morning would get no
// nudge before it. That is the single most valuable email here for preventing a
// no-show, and its worth comes from being close to the CALL, not from being far
// from the booking. The same argument covers the 24-hour reminder: "your call is
// tomorrow" is a proximity alert, and it is still true and still useful six
// hours after someone books.
const MIN_GAP_AFTER_BOOKING_MS = 24 * HOUR

const BOOKING_REMINDERS: { kind: string; before: number; heading: string; horizon: boolean }[] = [
  { kind: 'reminder_1w', before: 7 * DAY, heading: 'Your call is next week', horizon: true },
  { kind: 'reminder_3d', before: 3 * DAY, heading: 'Your call is in 3 days', horizon: true },
  { kind: 'reminder_24h', before: 24 * HOUR, heading: 'Your call is tomorrow', horizon: false },
  { kind: 'reminder_1h', before: 1 * HOUR, heading: 'Your call is in 1 hour', horizon: false },
]

export type BookingReminderContext = {
  /** Whose brand the emails wear. Resolve with resolveBookingBrand. */
  brand: CoachBrand
  /** NULL for a public booking — see migration 089. */
  funnelId?: string | null
  /** NULL when no lead matches, which is always true for a public booking. */
  leadId?: string | null
  email: string
  startIso: string
  joinUrl: string
  bookingId: string
  manageUrl?: string
  /** The zone the visitor booked in, when one was captured. */
  timezone?: string | null
  nowMs?: number
}

/**
 * Schedule the reminder set for one booking.
 *
 * TAKES WHAT IT NEEDS, not a Funnel. It used to require a Funnel as its first
 * argument and destructure two fields from it, which is precisely what kept the
 * public path out: a public booking has no funnel to pass. One function serves
 * both callers rather than a second copy that drifts within a month.
 *
 * SHORT NOTICE IS HANDLED BY SKIPPING, NOT BY CLAMPING. An offset already in the
 * past is not scheduled at all — a booking two days out gets 24h and 1h and no
 * "your call is next week", rather than a row dated in the past that Resend
 * would either reject or fire immediately. The +60s margin keeps a reminder that
 * would land within the next minute out of the set too, since a scheduled send
 * that close is indistinguishable from an immediate one.
 *
 * UNSUBSCRIBE, decided explicitly rather than left to fall out of the code:
 *   - No lead (public booking): nothing to check, and nothing to check it
 *     against. The booking itself is the consent — someone who just picked a
 *     time is asking to be reminded of it. Reminders are scheduled.
 *   - A lead who has unsubscribed: reminders are SKIPPED, which is the existing
 *     behaviour and is kept deliberately. These are transactional and a case
 *     could be made either way, but a five-touch cadence is exactly what
 *     somebody who asked us to stop emailing would be objecting to. The
 *     confirmation still goes out, because that is the receipt for an action
 *     they took a second ago.
 */
export async function scheduleBookingReminders(ctx: BookingReminderContext): Promise<void> {
  try {
    if (!ctx.email) return
    // Only a real lead can have unsubscribed; a public booking has nobody to ask.
    if (ctx.leadId && (await isUnsubscribed(ctx.leadId))) return

    const startMs = new Date(ctx.startIso).getTime()
    if (!Number.isFinite(startMs)) return
    const nowMs = ctx.nowMs ?? Date.now()

    const label = bookingTimeLabel(ctx.startIso, ctx.timezone ?? null)
    const manageLine = ctx.manageUrl
      ? `<p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">Need to change your time? You can <a href="${escapeHtml(ctx.manageUrl)}" target="_blank" style="color:#8A94A6;text-decoration:underline;">reschedule or cancel here</a>.</p>`
      : ''

    const tasks: Promise<unknown>[] = []
    for (const r of BOOKING_REMINDERS) {
      const at = startMs - r.before
      if (at <= nowMs + 60_000) continue // in the past / too soon to schedule
      if (r.horizon && at - nowMs < MIN_GAP_AFTER_BOOKING_MS) continue // reads as redundant next to the confirmation
      const bodyHtml = `
          <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">A quick reminder about your call:</p>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(label)}</p>${manageLine}`
      const html = brandedEmailHtml(ctx.brand, { heading: r.heading, bodyHtml, cta: { label: 'Join the call', url: ctx.joinUrl } })
      tasks.push(
        scheduleFunnelEmail({
          brand: ctx.brand,
          funnelId: ctx.funnelId ?? null,
          leadId: ctx.leadId ?? null,
          kind: r.kind,
          to: ctx.email,
          subject: r.heading,
          html,
          scheduledAt: new Date(at).toISOString(),
          bookingId: ctx.bookingId,
        })
      )
    }
    await Promise.all(tasks)
  } catch (err) {
    console.error('[nurture] scheduleBookingReminders', err)
  }
}

// Post-call follow-up: the 3 emails a coach sends after the call actually
// happened. Scheduled from the moment attendance is marked (which is after the
// call), NOT from start_time — a call marked days late should still get a
// sensible cadence rather than three emails landing at once.
//
// The content is the coach's own post_call_emails Growth Kit asset, in its
// stored order: (1) they said yes, (2) they are thinking about it, (3) they went
// quiet. Nothing is generated here; if the coach has not built the asset there is
// nothing to send and this is a silent no-op.
//
// This is ONLY ever reached from an attendance mark of 'showed'. Sending a
// "great call" sequence to someone who never turned up is the failure mode the
// no_show branch exists to prevent, so the caller's check is the contract and
// this function never infers attendance for itself.
export async function schedulePostCallEmails(
  funnel: Funnel,
  leadId: string,
  email: string,
  bookingId: string,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    if (!email) return
    if (await isUnsubscribed(leadId)) return

    const { data: asset } = await supabase
      .from('funnel_launch_assets')
      .select('content')
      .eq('funnel_id', funnel.id as string)
      .eq('asset_type', 'post_call_emails')
      .maybeSingle()
    const emails = coerceEmails((asset?.content as { emails?: unknown } | null)?.emails)
    if (!emails.length) return

    const subdomain = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
    const [brand, guideUrl] = await Promise.all([loadCoachBrand(funnel.user_id as string), loadGuideUrl(funnel)])
    await scheduleSet({
      funnel,
      brand,
      leadId,
      to: email,
      emails,
      kindPrefix: 'post_call',
      offsets: POST_CALL_OFFSETS,
      subdomain,
      bookUrlForTokens: subdomain ? bookUrl(subdomain) : '',
      guideUrl,
      defaultSubjects: POST_CALL_SUBJECTS,
      nowMs,
      bookingId,
    })
  } catch (err) {
    console.error('[nurture] schedulePostCallEmails', err)
  }
}

// Cancel the post-call sequence for ONE booking. Used when attendance is
// corrected from 'showed' to 'no_show' — the follow-ups were scheduled on a
// mistake and must not land.
export async function cancelPostCallEmails(bookingId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('funnel_email_sends')
      .select('resend_message_id')
      .eq('booking_id', bookingId)
      .eq('status', 'queued')
      .like('kind', 'post_call%')
    const ids = (data || []).map((r) => (r as { resend_message_id: string | null }).resend_message_id).filter((x): x is string => !!x)
    if (ids.length) await cancelFunnelSends(ids)
    await supabase
      .from('funnel_email_sends')
      .update({ status: 'canceled' })
      .eq('booking_id', bookingId)
      .eq('status', 'queued')
      .like('kind', 'post_call%')
  } catch (err) {
    console.error('[nurture] cancelPostCallEmails', err)
  }
}

// Cancel scheduled Resend messages for a lead and flip the rows to 'canceled'.
// kindPrefix null = the whole queue (booked/closed/unsubscribe/bounce);
// 'nurture' = only the nurture track (the watch pivot).
async function cancelByFilter(leadId: string, kindPrefix: string | null): Promise<void> {
  try {
    let sel = supabase.from('funnel_email_sends').select('resend_message_id').eq('lead_id', leadId).eq('status', 'queued')
    if (kindPrefix) sel = sel.like('kind', `${kindPrefix}%`)
    const { data } = await sel
    const ids = (data || []).map((r) => (r as { resend_message_id: string | null }).resend_message_id).filter((x): x is string => !!x)
    if (ids.length) await cancelFunnelSends(ids)

    let upd = supabase.from('funnel_email_sends').update({ status: 'canceled' }).eq('lead_id', leadId).eq('status', 'queued')
    if (kindPrefix) upd = upd.like('kind', `${kindPrefix}%`)
    await upd
  } catch (err) {
    console.error('[nurture] cancelByFilter', err)
  }
}

// Cancel EVERY still-scheduled send for a lead — booked, closed, unsubscribed,
// bounced. Idempotent.
export async function cancelLeadQueue(leadId: string): Promise<void> {
  await cancelByFilter(leadId, null)
}

// Cancel only the nurture track (used by the pivot to book-a-call).
export async function cancelNurtureQueue(leadId: string): Promise<void> {
  await cancelByFilter(leadId, 'nurture')
}

// Cancel a lead's queued OUTREACH — nurture + book-a-call, but NOT booking
// reminders (kind NOT LIKE 'reminder%'). Used when a lead books or moves to a
// post-booking status: they exit the sequence, but their per-booking reminders
// must survive, since a lead can hold multiple bookings (those are canceled per
// booking by cancelBookingReminders).
export async function cancelLeadOutreach(leadId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('funnel_email_sends')
      .select('resend_message_id')
      .eq('lead_id', leadId)
      .eq('status', 'queued')
      .not('kind', 'like', 'reminder%')
    const ids = (data || []).map((r) => (r as { resend_message_id: string | null }).resend_message_id).filter((x): x is string => !!x)
    if (ids.length) await cancelFunnelSends(ids)
    await supabase
      .from('funnel_email_sends')
      .update({ status: 'canceled' })
      .eq('lead_id', leadId)
      .eq('status', 'queued')
      .not('kind', 'like', 'reminder%')
  } catch (err) {
    console.error('[nurture] cancelLeadOutreach', err)
  }
}

// Cancel the 24h/1h reminders for ONE booking (by booking_id, so a lead's other
// bookings are untouched). Used on cancel and before re-scheduling on a move.
export async function cancelBookingReminders(bookingId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('funnel_email_sends')
      .select('resend_message_id')
      .eq('booking_id', bookingId)
      .eq('status', 'queued')
    const ids = (data || []).map((r) => (r as { resend_message_id: string | null }).resend_message_id).filter((x): x is string => !!x)
    if (ids.length) await cancelFunnelSends(ids)
    await supabase.from('funnel_email_sends').update({ status: 'canceled' }).eq('booking_id', bookingId).eq('status', 'queued')
  } catch (err) {
    console.error('[nurture] cancelBookingReminders', err)
  }
}

// ── Warm-invite broadcast ────────────────────────────────────────────────────
// The coach mails their OWN list once per funnel, from coach_contacts. Same
// send stack as every other sequence (funnel_email_sends + Resend + the webhook)
// so the Emails tab's kind aggregation lights up with no special-casing.
//
// Two things separate it from the lead sequences:
//   - There is no lead. Recipients are contacts, so the send rows carry
//     contact_id and leave lead_id null. Nothing here writes funnel_leads: an
//     imported address never visited the funnel, and counting it as a lead
//     would inflate visits and opt-in rate.
//   - There is therefore no watch token. [TRAINING_LINK] resolves to the plain
//     training URL — attribution needs a lead, and inventing one to get a token
//     is exactly what corrupts the analytics.
const INVITE_OFFSETS = [0, 2 * DAY, 4 * DAY]
const INVITE_SUBJECTS = [
  'I made something for you',
  'Did you get a chance to look?',
  'Last note about this',
]

/** Unsubscribe for a contact. `c:` marks the id as a contact, not a lead. */
function contactUnsubscribeUrl(funnelId: string, contactId: string): string {
  return `${API_URL}/api/funnel/unsubscribe?token=${encodeURIComponent(
    signUnsubscribeToken(funnelId, `c:${contactId}`)
  )}`
}

export type BroadcastContact = { id: string; email: string; first_name: string | null }

/**
 * Enrols every sendable contact in the funnel's warm-invite sequence
 * (now, +2d, +4d). Returns how many contacts were enrolled.
 *
 * Idempotency is NOT enforced here — the caller claims funnel_invite_broadcasts
 * first, whose unique index on funnel_id is what makes a second click a
 * conflict rather than a second mailing.
 */
export async function scheduleInviteBroadcast(
  funnel: Funnel,
  contacts: BroadcastContact[],
  nowMs: number = Date.now()
): Promise<number> {
  const subdomain = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
  if (!subdomain || contacts.length === 0) return 0

  const emails = coerceEmails(funnel.warm_invite_emails)
  if (!emails.length) return 0

  const [brand, guideUrl] = await Promise.all([
    loadCoachBrand(funnel.user_id as string),
    loadGuideUrl(funnel),
  ])
  const book = bookUrl(subdomain)
  const training = trainingUrl(subdomain)
  const n = Math.min(emails.length, INVITE_OFFSETS.length)

  // Sequential per contact rather than one big Promise.all: a large list would
  // otherwise open thousands of concurrent Resend calls and trip its rate limit,
  // failing sends that would each have succeeded on their own.
  for (const contact of contacts) {
    const unsub = contactUnsubscribeUrl(funnel.id as string, contact.id)
    for (let i = 0; i < n; i++) {
      const em = emails[i]
      const sendTimeMs = nowMs + INVITE_OFFSETS[i]
      const subject =
        (em.subject && em.subject.trim()) || INVITE_SUBJECTS[i] || INVITE_SUBJECTS[INVITE_SUBJECTS.length - 1]

      // No `cta` here either — the button lives inside bodyHtml now.
      const { bodyHtml, cta, buttonRendered } = composeEmailBody(em.body, { book, training, guide: guideUrl }, brand.primaryColor)
      const html = brandedEmailHtml(brand, {
        heading: subject,
        bodyHtml,
        ...(buttonRendered && cta ? { ctaFallbackUrl: cta.url } : {}),
        unsubscribeUrl: unsub,
      })

      await scheduleFunnelEmail({
        brand,
        funnelId: funnel.id as string,
        leadId: null,
        contactId: contact.id,
        kind: `invite_${i + 1}`,
        to: contact.email,
        subject,
        html,
        ...(INVITE_OFFSETS[i] > 0 ? { scheduledAt: new Date(sendTimeMs).toISOString() } : {}),
      })
    }
  }

  return contacts.length
}
