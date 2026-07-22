import { Resend } from 'resend'
import crypto from 'crypto'
import { supabase } from './supabase'
import { loadBusinessSettings, isValidHttpUrl } from './businessSettings'
import { sanitizeBrandColor, DEFAULT_BRAND_PRIMARY } from './funnels'

const resend = new Resend(process.env.RESEND_API_KEY!)
// The API's own public base URL — NOT the frontend (that's APP_URL). The
// magic-link email must point at the BACKEND token processor
// (GET /api/auth/callback), which validates the magic token and then
// 302-redirects to the frontend's /auth-callback route with a session token.
// Pointing the email at the frontend 404s: the SPA has no /auth/callback.
const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

export async function sendMagicLinkEmail(email: string, name: string, token: string) {
  const link = `${API_URL}/api/auth/callback?token=${encodeURIComponent(token)}`

  // Sends via the published Resend template (alias mtm-login-link) so the
  // email carries the MTM branding managed in Resend, not inline HTML here.
  // The template defines the subject and body; NAME and LOGIN_LINK are its
  // variables. Requires resend >= 6 for template sends.
  const { error } = await resend.emails.send({
    from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
    to: email,
    template: {
      id: 'mtm-login-link',
      variables: {
        NAME: name || 'there',
        LOGIN_LINK: link,
      },
    },
  })

  // resend's send() returns errors rather than throwing — surface them so a
  // failed send doesn't silently look like success to the caller.
  if (error) throw new Error(`[email] magic-link send failed: ${error.message}`)
}

// Published welcome templates, keyed by the membership tier GRANTED — not by
// the product label (accelerator and legacy 'full' both grant 'full' and get
// the Accelerator welcome) and not by has_paid (non-paid beta still gets its
// welcome). workshop and free deliberately have NO template: workshop has its
// own date-driven flow, free has no app access.
const WELCOME_TEMPLATE_BY_TIER: Record<string, string> = {
  low_ticket: 'mtm-welcome-entry',
  full: 'mtm-accelerator-welcome',
  beta: 'mtm-beta-welcome',
}

// Tier welcome email with a one-click login button. Mints a fresh
// single-use magic-link token (same shape as api/auth/send-magic-link — 15
// minute expiry; opened later, the callback degrades cleanly to /login) and
// sends the tier's template with NAME (first name) + LOGIN_LINK.
//
// Best-effort BY CONTRACT: this function never throws. It runs inside the
// grant paths (Stripe webhook, GHL create-paid), and a failed email must
// never fail the grant it celebrates — failures are logged loudly instead.
// Tiers without a welcome template are a silent no-op.
export async function sendTierWelcomeEmail(
  userId: string,
  email: string,
  firstName: string | null,
  grantedTier: string,
  idempotencyKey?: string
): Promise<void> {
  try {
    const templateId = WELCOME_TEMPLATE_BY_TIER[grantedTier]
    if (!templateId) return

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: userId, token, expires_at: expiresAt })
    if (tokenError) throw tokenError

    const { error } = await resend.emails.send(
      {
        from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
        to: email,
        template: {
          id: templateId,
          variables: {
            NAME: firstName || 'there',
            LOGIN_LINK: `${API_URL}/api/auth/callback?token=${encodeURIComponent(token)}`,
          },
        },
      },
      idempotencyKey ? { idempotencyKey } : undefined
    )
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] tier welcome send failed (tier=${grantedTier}, user=${userId})`, err)
  }
}

// ---- funnel-scoped email tracking (Phase 5a) --------------------------------
// A funnel-scoped send carries Resend `tags` (funnel_id, lead_id, kind) for
// Resend-side filtering AND writes a funnel_email_sends row keyed by the returned
// message id, so a later open/click/bounce webhook can resolve the send back to
// its funnel + lead. Both are additive: a send with no funnel context behaves
// exactly as before (no tags, no record).

// Resend tag values are ASCII [A-Za-z0-9_-] only. UUIDs and our fixed kind
// literals already qualify; the guard is defense so a bad value can never make a
// send throw (the email must go out regardless of tracking).
const TAG_SAFE = /^[A-Za-z0-9_-]+$/
function funnelTags(funnelId?: string, leadId?: string | null, kind?: string): { name: string; value: string }[] {
  const tags: { name: string; value: string }[] = []
  if (funnelId && TAG_SAFE.test(funnelId)) tags.push({ name: 'funnel_id', value: funnelId })
  if (leadId && TAG_SAFE.test(leadId)) tags.push({ name: 'lead_id', value: leadId })
  if (kind && TAG_SAFE.test(kind)) tags.push({ name: 'kind', value: kind })
  return tags
}

// Record a funnel-scoped send. Best-effort — a tracking-row failure must never
// affect the email that already went out. status 'queued' = handed to Resend
// with a scheduledAt and still cancelable; 'sent' = delivered immediately.
async function recordFunnelEmailSend(row: {
  funnelId: string
  leadId: string | null
  kind: string
  messageId: string | null
  status: 'queued' | 'sent' | 'failed'
  scheduledAt?: string | null
}): Promise<void> {
  try {
    const { error } = await supabase.from('funnel_email_sends').insert({
      funnel_id: row.funnelId,
      lead_id: row.leadId,
      kind: row.kind,
      resend_message_id: row.messageId,
      status: row.status,
      scheduled_at: row.scheduledAt ?? null,
    })
    if (error) console.error('[email] funnel_email_sends record failed', error)
  } catch (err) {
    console.error('[email] funnel_email_sends record threw', err)
  }
}

// ---- coach-branded funnel email layout (Phase 5b) ---------------------------
// A funnel email goes FROM the coach TO their lead, so it must wear the COACH's
// brand, never MTM's. One shared layout sourced from the coach's business
// settings + account. The verified sending domain stays MTM's (deliverability);
// only the display name, logo, accent, signature, and reply-to are the coach's.

export type CoachBrand = {
  fromName: string // sanitized display name for the From header (the coach's first name)
  coachName: string // the coach's name, for the email signature; escaped at render
  businessName: string // raw; escaped at render — header fallback + "Sent by" line
  replyTo: string | null // the coach's email
  logoUrl: string | null // validated http(s) or null
  primaryColor: string // sanitized color, safe to interpolate
}

// A From display name can't contain quotes/angle-brackets/commas/newlines
// without breaking the header — strip them. Never empty, never "MTM".
function sanitizeDisplayName(s: string): string {
  const cleaned = String(s || '')
    .replace(/[\"<>,\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Your coach'
}

export async function loadCoachBrand(userId: string): Promise<CoachBrand> {
  const [settings, userRes] = await Promise.all([
    loadBusinessSettings(userId),
    supabase.from('users').select('name, email').eq('id', userId).maybeSingle(),
  ])
  const user = (userRes.data || {}) as { name?: string | null; email?: string | null }
  const rawName = typeof user.name === 'string' ? user.name.trim() : ''
  const firstName = rawName ? rawName.split(/\s+/)[0] : ''
  const businessName = settings.business_name || rawName || 'Your coach'
  const coachName = rawName || 'Your coach'
  const replyTo = typeof user.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user.email) ? user.email : null
  return {
    // From display = the coach's first name, then business name, then a safe
    // default (sanitizeDisplayName returns 'Your coach' when its input is empty).
    fromName: sanitizeDisplayName(firstName || settings.business_name || ''),
    coachName,
    businessName,
    replyTo,
    logoUrl: settings.logo_url && isValidHttpUrl(settings.logo_url) ? settings.logo_url : null,
    primaryColor: sanitizeBrandColor(settings.brand_primary_color, DEFAULT_BRAND_PRIMARY),
  }
}

// Coach-branded HTML shell. Header = coach logo, else the business name as text
// (never the MTM wordmark). Accent/button = the coach's primary color (already
// sanitized). Signature = business name. Every interpolated value is escaped /
// URL-validated here so callers can't inject.
export function brandedEmailHtml(
  brand: CoachBrand,
  opts: { heading: string; bodyHtml: string; cta?: { label: string; url: string }; unsubscribeUrl?: string }
): string {
  const color = brand.primaryColor
  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.businessName)}" height="40" style="max-height:40px;border:0;display:block;" />`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;letter-spacing:.5px;color:#0B1120;">${escapeHtml(brand.businessName)}</div>`
  const button =
    opts.cta && isValidHttpUrl(opts.cta.url)
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 6px;"><tr>
            <td align="center" bgcolor="${color}" style="background-color:${color};border-radius:10px;">
              <a href="${escapeHtml(opts.cta.url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(opts.cta.label)}</a>
            </td></tr></table>`
      : ''
  const foot =
    opts.unsubscribeUrl && isValidHttpUrl(opts.unsubscribeUrl)
      ? `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#98A2B3;">Sent by ${escapeHtml(brand.businessName)}. <a href="${escapeHtml(opts.unsubscribeUrl)}" target="_blank" style="color:#98A2B3;text-decoration:underline;">Unsubscribe</a>.</p>`
      : `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#98A2B3;">Sent by ${escapeHtml(brand.businessName)}.</p>`
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F4F6F9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;">
        <tr><td style="padding-bottom:22px;padding-left:4px;">${header}</td></tr>
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E5E9F0;border-radius:14px;padding:34px 32px;">
          <h1 style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:21px;line-height:29px;font-weight:bold;color:#0B1120;">${escapeHtml(opts.heading)}</h1>
          ${opts.bodyHtml}
          ${button}
        </td></tr>
        <tr><td style="padding-top:20px;padding-left:4px;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;color:#98A2B3;">${escapeHtml(brand.coachName)}</p>
          ${foot}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// Turn an MtEmail plain-text body into safe paragraph HTML, linking the
// [BOOK_A_CALL_LINK] / [OFFER_LINK] tokens the generator embeds. escapeHtml
// leaves the bracket tokens intact so they survive to be replaced.
export function linkifyEmailBody(raw: string, bookUrl: string): string {
  const bookAnchor = isValidHttpUrl(bookUrl)
    ? `<a href="${escapeHtml(bookUrl)}" target="_blank" style="color:#0B1120;font-weight:bold;">book a call</a>`
    : 'book a call'
  return String(raw || '')
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => {
      const h = escapeHtml(p)
        .replace(/\r?\n/g, '<br>')
        .split('[BOOK_A_CALL_LINK]')
        .join(bookAnchor)
        .split('[OFFER_LINK]')
        .join(bookAnchor)
      return `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">${h}</p>`
    })
    .join('')
}

// The one Resend entry point for scheduled/immediate funnel nurture sends.
// scheduledAt (ISO) omitted → send now; present → Resend schedules it and the
// row is recorded 'queued' (cancelable via cancelFunnelSends). Returns the
// Resend message id (or null on failure). Never throws.
export async function scheduleFunnelEmail(opts: {
  brand: CoachBrand
  funnelId: string
  leadId: string | null
  kind: string
  to: string
  subject: string
  html: string
  scheduledAt?: string
}): Promise<string | null> {
  try {
    const { data, error } = await resend.emails.send({
      from: `${opts.brand.fromName} <noreply@mail.microtrainingmethod.com>`,
      to: opts.to,
      ...(opts.brand.replyTo ? { replyTo: opts.brand.replyTo } : {}),
      subject: opts.subject,
      tags: funnelTags(opts.funnelId, opts.leadId, opts.kind),
      ...(opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : {}),
      html: opts.html,
    })
    const status: 'queued' | 'sent' | 'failed' = error ? 'failed' : opts.scheduledAt ? 'queued' : 'sent'
    await recordFunnelEmailSend({
      funnelId: opts.funnelId,
      leadId: opts.leadId,
      kind: opts.kind,
      messageId: data?.id ?? null,
      status,
      scheduledAt: opts.scheduledAt ?? null,
    })
    if (error) {
      console.error('[email] scheduleFunnelEmail send failed', opts.kind, error)
      return null
    }
    return data?.id ?? null
  } catch (err) {
    console.error('[email] scheduleFunnelEmail threw', opts.kind, err)
    return null
  }
}

// Cancel scheduled Resend messages by id (the nurture queue). Best-effort per
// id; an already-delivered or unknown id just logs. The caller flips the
// funnel_email_sends rows to 'canceled' separately.
export async function cancelFunnelSends(messageIds: string[]): Promise<void> {
  for (const id of messageIds) {
    if (!id) continue
    try {
      await resend.emails.cancel(id)
    } catch (err) {
      console.error('[email] cancel failed', id, err)
    }
  }
}

// Booking confirmation with the Zoom join link and an attached .ics so the
// meeting lands on the customer's calendar. Best-effort BY CONTRACT: never
// throws — a mail hiccup must not fail a booking that already succeeded (the
// Zoom meeting exists and the row is stored either way). Inline branded HTML
// (no dedicated template alias for this yet), MTM light theme, from the
// verified MTM domain. startLocalLabel is a human-readable time string the
// caller formats; the .ics carries the authoritative UTC times.
//
// funnelId/leadId (Phase 5a): when present, the send is tagged and recorded in
// funnel_email_sends so its opens/clicks attribute to this lead.
// coachUserId (Phase 5b): when present (a funnel booking), the email wears the
// COACH's brand; absent (a legacy non-funnel booking) it stays MTM-branded.
export async function sendBookingConfirmationEmail(opts: {
  email: string
  name: string | null
  startLabel: string
  joinUrl: string
  icsContent: string
  funnelId?: string
  leadId?: string | null
  coachUserId?: string
}): Promise<void> {
  try {
    const kind = 'booking_confirmation'

    let from = 'Micro-Training Method <noreply@mail.microtrainingmethod.com>'
    let replyTo: string | undefined
    let html: string

    if (opts.coachUserId) {
      const brand = await loadCoachBrand(opts.coachUserId)
      from = `${brand.fromName} <noreply@mail.microtrainingmethod.com>`
      replyTo = brand.replyTo ?? undefined
      const bodyHtml = `
          <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">Hey ${escapeHtml(opts.name || 'there')},</p>
          <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">You're all set. Here are the details:</p>
          <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(opts.startLabel)}</p>
          <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">The attached calendar file will add this to your calendar.</p>`
      html = brandedEmailHtml(brand, { heading: 'Your call is booked', bodyHtml, cta: { label: 'Join the call', url: opts.joinUrl } })
    } else {
      html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#F4F6F9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:520px;">
        <tr><td style="padding-bottom:26px; padding-left:8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-family:Arial,Helvetica,sans-serif; font-size:26px; font-weight:bold; letter-spacing:1px; color:#0B1120; padding-bottom:6px;">MTM</td></tr>
            <tr><td bgcolor="#5FA828" style="width:34px; height:3px; line-height:3px; font-size:3px; background-color:#5FA828;">&nbsp;</td></tr>
            <tr><td style="font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:2px; color:#8A94A6; padding-top:8px;">MICRO-TRAINING METHOD</td></tr>
          </table>
        </td></tr>
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF; border:1px solid #E5E9F0; border-radius:14px; padding:36px 32px;">
          <h1 style="margin:0 0 18px; font-family:Arial,Helvetica,sans-serif; font-size:22px; line-height:30px; font-weight:bold; color:#0B1120;">Your call is booked</h1>
          <p style="margin:0 0 14px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#4B5563;">Hey ${escapeHtml(opts.name || 'there')},</p>
          <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#4B5563;">You're all set. Here are the details:</p>
          <p style="margin:0 0 26px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#0B1120; font-weight:bold;">${escapeHtml(opts.startLabel)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="#5FA828" style="background-color:#5FA828; border-radius:10px;">
              <a href="${escapeHtml(opts.joinUrl)}" target="_blank" style="display:inline-block; padding:14px 30px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; color:#FFFFFF; text-decoration:none; border-radius:10px;">Join the call</a>
            </td>
          </tr></table>
          <p style="margin:26px 0 6px; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; color:#8A94A6;">Or paste this link into your browser:</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; word-break:break-all;"><a href="${escapeHtml(opts.joinUrl)}" target="_blank" style="color:#3B7A16; text-decoration:none;">${escapeHtml(opts.joinUrl)}</a></p>
          <p style="margin:24px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; color:#8A94A6;">The attached calendar file will add this to your calendar.</p>
        </td></tr>
        <tr><td style="padding-top:24px; padding-left:8px;">
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:20px; color:#98A2B3;">Micro-Training Method</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
    }

    const { data, error } = await resend.emails.send({
      from,
      to: opts.email,
      ...(replyTo ? { replyTo } : {}),
      subject: 'Your call is booked',
      attachments: [{ filename: 'invite.ics', content: Buffer.from(opts.icsContent) }],
      ...(opts.funnelId ? { tags: funnelTags(opts.funnelId, opts.leadId, kind) } : {}),
      html,
    })
    if (opts.funnelId) {
      await recordFunnelEmailSend({
        funnelId: opts.funnelId,
        leadId: opts.leadId ?? null,
        kind,
        messageId: data?.id ?? null,
        status: error ? 'failed' : 'sent',
      })
    }
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] booking confirmation send failed (to=${opts.email})`, err)
  }
}

// Coach notification when a lead books from their funnel. Best-effort BY
// CONTRACT: never throws — a mail hiccup must not fail a booking that already
// succeeded. Short, plain, MTM-styled; includes the time and the lead's answers.
// funnelId (Phase 5a): the notification is tagged and recorded, but with
// lead_id NULL by design — a coach opening their own operational notice is NOT
// lead engagement, so it must never post an email_opened onto the lead's feed.
// coachUserId (Phase 5b): the notice wears the coach's brand (it's their
// business); it stays MTM-branded only if the coach can't be resolved.
export async function sendCoachBookingNotification(opts: {
  coachEmail: string
  leadName: string
  leadEmail: string
  startLabel: string
  answers: Array<{ label: string; answer: string }>
  funnelId?: string
  coachUserId?: string
}): Promise<void> {
  try {
    if (!opts.coachEmail) return
    const kind = 'coach_booking_notification'
    const answerRows = opts.answers
      .filter((a) => a.answer)
      .map(
        (a) =>
          `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;padding:2px 12px 2px 0;vertical-align:top;">${escapeHtml(a.label)}</td><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#0B1120;padding:2px 0;">${escapeHtml(a.answer)}</td></tr>`
      )
      .join('')

    const brand = opts.coachUserId ? await loadCoachBrand(opts.coachUserId) : null
    const from = brand ? `${brand.fromName} <noreply@mail.microtrainingmethod.com>` : 'Micro-Training Method <noreply@mail.microtrainingmethod.com>'

    const bodyHtml = `
          <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(opts.startLabel)}</p>
          <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#4B5563;">${escapeHtml(opts.leadName)} &lt;${escapeHtml(opts.leadEmail)}&gt;</p>
          ${answerRows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5E9F0;padding-top:12px;margin-top:4px;">${answerRows}</table>` : ''}
          <p style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">It's on your calendar. The lead has the meeting link.</p>`

    const html = brand
      ? brandedEmailHtml(brand, { heading: 'You have a new call booked', bodyHtml })
      : `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#F4F6F9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;">
    <tr><td align="center" style="padding:36px 16px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;">
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E5E9F0;border-radius:14px;padding:32px;">
          <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:28px;font-weight:bold;color:#0B1120;">You have a new call booked</h1>
          ${bodyHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

    const { data, error } = await resend.emails.send({
      from,
      to: opts.coachEmail,
      subject: `New booking: ${opts.leadName || opts.leadEmail}`,
      ...(opts.funnelId ? { tags: funnelTags(opts.funnelId, null, kind) } : {}),
      html,
    })
    if (opts.funnelId) {
      await recordFunnelEmailSend({
        funnelId: opts.funnelId,
        leadId: null,
        kind,
        messageId: data?.id ?? null,
        status: error ? 'failed' : 'sent',
      })
    }
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] coach booking notification failed (to=${opts.coachEmail})`, err)
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// Beta invite welcome. Sends the published MTM beta template. The link is the
// caller's own token URL (invite-beta mints a 7-day token — intentionally
// long-lived for a cold invite), NOT sendTierWelcomeEmail's 15-minute token.
// Signature unchanged so api/members/invite-beta.ts needs no change.
export async function sendBetaWelcomeEmail(email: string, name: string, loginUrl: string) {
  const firstName = name && name.trim() ? name.trim().split(/\s+/)[0] : 'there'
  const { error } = await resend.emails.send({
    from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
    to: email,
    template: {
      id: 'mtm-beta-welcome',
      variables: { NAME: firstName, LOGIN_LINK: loginUrl },
    },
  })
  if (error) throw new Error(`[email] beta welcome send failed: ${error.message}`)
}
