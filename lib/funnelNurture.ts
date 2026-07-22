import { supabase } from './supabase'
import {
  CoachBrand,
  loadCoachBrand,
  brandedEmailHtml,
  linkifyEmailBody,
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

const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

const NURTURE_SUBJECTS = ['Your training is ready', 'Did you get a chance to watch?', 'Last chance to watch the training']
const BOOK_SUBJECTS = ['Ready for the next step?', 'One quick thing', 'A final invitation']

type Funnel = Record<string, any>

function publicBase(subdomain: string): string {
  return `https://${subdomain}.${FUNNEL_DOMAIN}`
}
function trainingUrl(subdomain: string, wt: string): string {
  return `${publicBase(subdomain)}/?page=training&wt=${encodeURIComponent(wt)}`
}
function bookUrl(subdomain: string): string {
  return `${publicBase(subdomain)}/?page=book`
}
function unsubscribeUrl(funnelId: string, leadId: string): string {
  return `${API_URL}/api/funnel/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(funnelId, leadId))}`
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
function utcLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' (UTC)'
  } catch {
    return iso
  }
}

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
  kindPrefix: 'nurture' | 'book_a_call'
  offsets: number[]
  subdomain: string
  bookUrlForTokens: string
  defaultSubjects: string[]
  nowMs: number
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
    const cta =
      opts.kindPrefix === 'nurture'
        ? { label: 'Watch the training', url: training }
        : { label: 'Book your call', url: opts.bookUrlForTokens }

    const bodyHtml = linkifyEmailBody(em.body, opts.bookUrlForTokens, training)
    const html = brandedEmailHtml(opts.brand, { heading: subject, bodyHtml, cta, unsubscribeUrl: unsub })
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
    const brand = await loadCoachBrand(funnel.user_id as string)
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
    const brand = await loadCoachBrand(funnel.user_id as string)
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
      defaultSubjects: BOOK_SUBJECTS,
      nowMs,
    })
  } catch (err) {
    console.error('[nurture] pivotToBookACall', err)
  }
}

// Booking reminders: 24h and 1h before the call. Only schedules a reminder whose
// send time is still in the future (a call booked <1h out gets no 1h reminder).
export async function scheduleBookingReminders(
  funnel: Funnel,
  leadId: string,
  email: string,
  startIso: string,
  joinUrl: string,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    if (!email) return
    if (await isUnsubscribed(leadId)) return
    const startMs = new Date(startIso).getTime()
    if (!Number.isFinite(startMs)) return
    const brand = await loadCoachBrand(funnel.user_id as string)
    const label = utcLabel(startIso)

    const reminders = [
      { kind: 'reminder_24h', at: startMs - 24 * HOUR, heading: 'Your call is tomorrow' },
      { kind: 'reminder_1h', at: startMs - 1 * HOUR, heading: 'Your call is in 1 hour' },
    ]
    const tasks: Promise<unknown>[] = []
    for (const r of reminders) {
      if (r.at <= nowMs + 60_000) continue // in the past / too soon to schedule
      const bodyHtml = `
          <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">A quick reminder about your call:</p>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(label)}</p>`
      const html = brandedEmailHtml(brand, { heading: r.heading, bodyHtml, cta: { label: 'Join the call', url: joinUrl } })
      tasks.push(
        scheduleFunnelEmail({
          brand,
          funnelId: funnel.id as string,
          leadId,
          kind: r.kind,
          to: email,
          subject: r.heading,
          html,
          scheduledAt: new Date(r.at).toISOString(),
        })
      )
    }
    await Promise.all(tasks)
  } catch (err) {
    console.error('[nurture] scheduleBookingReminders', err)
  }
}

// Cancel scheduled Resend messages for a lead and flip the rows to 'canceled'.
// kindPrefix null = the whole queue (booked/closed/unsubscribe/bounce);
// 'nurture' = only the nurture track (the watch pivot).
async function cancelByFilter(leadId: string, kindPrefix: 'nurture' | null): Promise<void> {
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
