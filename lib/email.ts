import { Resend } from 'resend'
import crypto from 'crypto'
import { supabase } from './supabase'
import { loadBusinessSettings, isValidHttpUrl } from './businessSettings'
import { sanitizeBrandColor, DEFAULT_BRAND_PRIMARY } from './funnels'
import { loadUserAvailability } from './availabilitySettings'

// Exported so api/webhooks/resend.ts can make the one follow-up call inbound
// mail needs (fetching a received email's actual body) without constructing
// a second client keyed by the same API key.
export const resend = new Resend(process.env.RESEND_API_KEY!)
// The API's own public base URL — NOT the frontend (that's APP_URL). The
// magic-link email must point at the BACKEND token processor
// (GET /api/auth/callback), which validates the magic token and then
// 302-redirects to the frontend's /auth-callback route with a session token.
// Pointing the email at the frontend 404s: the SPA has no /auth/callback.
const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'
// The FRONTEND's own base URL — used for coach-notification links that point
// INTO the builder (e.g. a specific lead), as opposed to API_URL above.
const APP_URL = process.env.APP_URL || 'https://app.clientatmbuilder.com'

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
  // Set only on invite_* sends, which go to a coach_contacts row instead of a
  // lead. Exactly the rows where leadId is null.
  contactId?: string | null
  kind: string
  messageId: string | null
  status: 'queued' | 'sent' | 'failed'
  scheduledAt?: string | null
  bookingId?: string | null
}): Promise<void> {
  try {
    const { error } = await supabase.from('funnel_email_sends').insert({
      funnel_id: row.funnelId,
      lead_id: row.leadId,
      contact_id: row.contactId ?? null,
      kind: row.kind,
      resend_message_id: row.messageId,
      status: row.status,
      scheduled_at: row.scheduledAt ?? null,
      booking_id: row.bookingId ?? null,
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
  // Button fallback: when there IS a CTA button, a plain P.S. below the signature
  // hyperlinks "Click here" to the SAME coach-specific destination. The raw URL is
  // never shown as visible text — freeminiworkshop.com is the shared base domain,
  // so a lead copying/typing the bare domain could land on a different coach's
  // funnel; only the full href carries the coach's own destination.
  const ps =
    opts.cta && isValidHttpUrl(opts.cta.url)
      ? `<p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;color:#98A2B3;">P.S. Button not working? <a href="${escapeHtml(opts.cta.url)}" target="_blank" style="color:#98A2B3;text-decoration:underline;">Click here</a>.</p>`
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
          ${ps}
          ${foot}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// Lightweight, safe inline formatting on ALREADY-ESCAPED text. The editor writes
// canonical markers; we render exactly these and nothing else (no raw HTML ever
// survives, because escapeHtml ran first and neither `*` nor `+` is escaped):
//   **text** → bold, ++text++ → underline, *text* → italic.
// Bold is done before italic so `**x**` isn't mis-parsed as two italics. Markers
// are single-line (processed per line), so a stray marker can't run away.
function applyInlineFormatting(escaped: string): string {
  return escaped
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\+\+([^\n]+?)\+\+/g, '<u>$1</u>')
    .replace(/\*([^\n]+?)\*/g, '<em>$1</em>')
}

// The tell-tale markers of an email body that arrived as RENDERED HTML (a past
// frontend regression) rather than canonical text. Canonical bodies use bracket
// tokens and lightweight markers, never these.
const RENDERED_EMAIL_HTML = /<p[\s/>]|class\s*=|href\s*=|contenteditable/i
export function emailBodyHasRawHtml(body: unknown): boolean {
  return typeof body === 'string' && RENDERED_EMAIL_HTML.test(body)
}

const EMAIL_P_STYLE = 'margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;'
const EMAIL_LIST_STYLE = 'margin:0 0 14px;padding-left:22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;'
const EMAIL_LI_STYLE = 'margin:0 0 6px;'

// Turn a canonical email body (plain text + link tokens + lightweight formatting
// markers) into safe branded HTML. Pipeline per line: escapeHtml → lightweight
// formatting (bold/italic/underline) → resolve the link tokens the generator
// embeds ([BOOK_A_CALL_LINK]/[OFFER_LINK] → book page, [TRAINING_LINK] → training,
// [REGISTER_LINK] → opt-in, [GUIDE_LINK] → guide download). Everything not a
// recognized marker/token is escaped, so no raw HTML from the body can reach the
// output. A missing/invalid URL degrades to plain words, never the literal token.
//
// Blocks are blank-line separated. Within a block, runs of `- ` lines become a
// <ul>, runs of `1. ` (any number) lines become an <ol>, and other lines join
// with <br> inside a <p>. Formatting and tokens compose (bold text can hold an
// inline link in the same line).
//
// EVERY token renders as a standard inline hyperlink here — including a token
// alone on its own line. This function never decides what becomes the button and
// never drops a token; that is composeEmailBody's job (it removes the single
// primary-CTA occurrence before calling this, so the button and the inline text
// never duplicate the same link).
export function linkifyEmailBody(
  raw: string,
  bookUrl: string,
  trainingUrl?: string,
  registerUrl?: string,
  guideUrl?: string
): string {
  const anchor = (url: string | undefined, label: string, fallback: string): string =>
    url && isValidHttpUrl(url)
      ? `<a href="${escapeHtml(url)}" target="_blank" style="color:#0B1120;font-weight:bold;">${label}</a>`
      : fallback
  const bookAnchor = anchor(bookUrl, 'book a call', 'book a call')
  const trainingAnchor = anchor(trainingUrl, 'watch the training', 'the training')
  const registerAnchor = anchor(registerUrl, 'register', 'register')
  const guideAnchor = anchor(guideUrl, 'download the guide', 'the guide')
  // escape → format → resolve tokens. Tokens are resolved LAST so their injected
  // anchor HTML is never re-escaped or re-formatted.
  const inline = (line: string): string =>
    applyInlineFormatting(escapeHtml(line))
      .split('[BOOK_A_CALL_LINK]')
      .join(bookAnchor)
      .split('[OFFER_LINK]')
      .join(bookAnchor)
      .split('[TRAINING_LINK]')
      .join(trainingAnchor)
      .split('[REGISTER_LINK]')
      .join(registerAnchor)
      .split('[GUIDE_LINK]')
      .join(guideAnchor)

  const isBullet = (l: string): boolean => /^\s*-\s+\S/.test(l)
  const isNumbered = (l: string): boolean => /^\s*\d+\.\s+\S/.test(l)

  const renderBlock = (block: string): string => {
    const lines = block.split(/\r?\n/)
    let out = ''
    let i = 0
    while (i < lines.length) {
      if (isBullet(lines[i])) {
        const items: string[] = []
        while (i < lines.length && isBullet(lines[i])) {
          items.push(inline(lines[i].replace(/^\s*-\s+/, '')))
          i++
        }
        out += `<ul style="${EMAIL_LIST_STYLE}">${items.map((t) => `<li style="${EMAIL_LI_STYLE}">${t}</li>`).join('')}</ul>`
      } else if (isNumbered(lines[i])) {
        const items: string[] = []
        while (i < lines.length && isNumbered(lines[i])) {
          items.push(inline(lines[i].replace(/^\s*\d+\.\s+/, '')))
          i++
        }
        out += `<ol style="${EMAIL_LIST_STYLE}">${items.map((t) => `<li style="${EMAIL_LI_STYLE}">${t}</li>`).join('')}</ol>`
      } else {
        const textLines: string[] = []
        while (i < lines.length && !isBullet(lines[i]) && !isNumbered(lines[i])) {
          textLines.push(lines[i])
          i++
        }
        const h = textLines.map(inline).join('<br>')
        if (h.replace(/<br>/g, '').trim()) out += `<p style="${EMAIL_P_STYLE}">${h}</p>`
      }
    }
    return out
  }

  return String(raw || '')
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map(renderBlock)
    .filter(Boolean)
    .join('')
}

// The tokens that MAY become the single CTA button, each with its button label
// and the links-key it resolves against. Order here is only the label/key map —
// primary selection is by READING ORDER in the body, not this list's order.
// [GUIDE_LINK] is deliberately absent: the guide/download link is NEVER a button.
const BUTTON_ELIGIBLE: { token: string; label: string; key: 'book' | 'training' | 'register' }[] = [
  { token: '[BOOK_A_CALL_LINK]', label: 'Book your call', key: 'book' },
  { token: '[OFFER_LINK]', label: 'Book your call', key: 'book' },
  { token: '[TRAINING_LINK]', label: 'Watch the training', key: 'training' },
  { token: '[REGISTER_LINK]', label: 'Register', key: 'register' },
]

export type EmailLinks = { book?: string; training?: string; register?: string; guide?: string }

// True when the token occupying [idx, idx+len) is ALONE on its own line (only
// surrounding whitespace) — the standalone-button case. An inline token (text on
// either side within the same line) is NOT standalone.
function isStandaloneOccurrence(body: string, idx: number, len: number): boolean {
  let start = idx
  while (start > 0 && body[start - 1] !== '\n') start--
  let end = idx + len
  while (end < body.length && body[end] !== '\n') end++
  return body.slice(start, idx).trim() === '' && body.slice(idx + len, end).trim() === ''
}

// The shared compose path for a token-bearing email body. Rules (per Jamaul):
//  1. At most ONE button, only for the primary CTA. No button-eligible token with
//     a valid URL ⇒ no button.
//  2. The PRIMARY CTA is the FIRST button-eligible token in reading order (not by
//     layout, not by a fixed token priority). It becomes the single button.
//     - If that occurrence is ALONE on its own line, it is removed from the body
//       so it isn't ALSO an inline link (the standalone-button case).
//     - If it sits INLINE within a sentence, it is KEPT in place as an inline link
//       so the sentence stays intact — the button is shown in addition. We never
//       delete text mid-sentence.
//  3. Every OTHER token — additional CTA tokens, later occurrences of the primary,
//     and [GUIDE_LINK] — renders as a standard inline hyperlink. Nothing is ever
//     silently dropped.
// Returns the paragraph HTML and the cta (or null). brandedEmailHtml appends the
// button + its P.S. fallback only when cta is present.
export function composeEmailBody(raw: string, links: EmailLinks): { bodyHtml: string; cta: { label: string; url: string } | null } {
  const body = String(raw || '')
  let cta: { label: string; url: string } | null = null
  let primaryIdx = -1
  let primaryLen = 0
  for (const spec of BUTTON_ELIGIBLE) {
    const url = links[spec.key]
    if (!url || !isValidHttpUrl(url)) continue
    const idx = body.indexOf(spec.token)
    if (idx === -1) continue
    if (primaryIdx === -1 || idx < primaryIdx) {
      primaryIdx = idx
      primaryLen = spec.token.length
      cta = { label: spec.label, url }
    }
  }
  // Only strip the primary token when it stands alone on its line (its line
  // collapses away in linkifyEmailBody). An inline primary stays put and renders
  // as an inline link too, so the surrounding sentence is never broken.
  const remainder =
    primaryIdx !== -1 && isStandaloneOccurrence(body, primaryIdx, primaryLen)
      ? body.slice(0, primaryIdx) + body.slice(primaryIdx + primaryLen)
      : body
  const bodyHtml = linkifyEmailBody(remainder, links.book || '', links.training, links.register, links.guide)
  return { bodyHtml, cta }
}

// Fire a single one-off email through the verified MTM sending domain (the
// coach's "send a test" action). Thin wrapper over resend.emails.send: no tags,
// no funnel recording — it is not a lead send. Returns the Resend message id (or
// null); throws on a Resend error so the caller can surface a clean failure.
export async function sendOneOffEmail(opts: {
  from: string
  to: string
  replyTo?: string | null
  subject: string
  html: string
}): Promise<string | null> {
  const { data, error } = await resend.emails.send({
    from: opts.from,
    to: opts.to,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject,
    html: opts.html,
  })
  if (error) throw new Error(error.message || 'Resend send failed')
  return data?.id ?? null
}

// The one Resend entry point for scheduled/immediate funnel nurture sends.
// scheduledAt (ISO) omitted → send now; present → Resend schedules it and the
// row is recorded 'queued' (cancelable via cancelFunnelSends). Returns the
// Resend message id (or null on failure). Never throws.
export async function scheduleFunnelEmail(opts: {
  brand: CoachBrand
  funnelId: string
  leadId: string | null
  contactId?: string | null
  kind: string
  to: string
  subject: string
  html: string
  scheduledAt?: string
  bookingId?: string
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
      contactId: opts.contactId ?? null,
      kind: opts.kind,
      messageId: data?.id ?? null,
      status,
      scheduledAt: opts.scheduledAt ?? null,
      bookingId: opts.bookingId ?? null,
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
  manageUrl?: string
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
          <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">The attached calendar file will add this to your calendar.</p>${manageSentence(opts.manageUrl)}`
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

// ---- coach notifications (new booking / application / opt-in) --------------
// Additive coach-facing operational notices, all sharing this file's Resend
// sender + coach-brand layout with the existing booking notices below. Each is
// gated on the coach's own funnel_business_settings.notification_prefs, and
// each claims a *_notified_at marker on the row the event fires from BEFORE
// sending — a retry/re-run that finds the marker already set skips silently,
// so a send is exactly-once per event no matter how many times the caller runs.
// Copy is plain and coach-facing (no internal jargon or system terms), per the
// language rule in STYLE_GUIDELINES (lib/promptGuidelines.ts).

// Funnel rows arrive here as the same loosely-typed Record<string, any> every
// call site already reads them as (resolveLiveFunnel's return type) — id and
// user_id are always present in practice (every row in `funnels` has both).
type NotifyFunnel = Record<string, any>

// Human-readable funnel name for notification copy. Mirrors the same
// label -> landing_page.headline -> subdomain fallback api/funnels/portfolio.ts
// uses for its display name — funnels has no dedicated `name` column.
function funnelDisplayName(f: NotifyFunnel): string {
  const label = typeof f.problem_solution_label === 'string' ? f.problem_solution_label.trim() : ''
  if (label) return label
  const headline = (f.landing_page && typeof f.landing_page === 'object' ? (f.landing_page as any).headline : null) as unknown
  if (typeof headline === 'string' && headline.trim()) return headline.trim()
  if (typeof f.subdomain === 'string' && f.subdomain.trim()) return f.subdomain.trim()
  return 'your funnel'
}

function coachLeadUrl(funnelId: string, leadId: string | null): string | null {
  return leadId ? `${APP_URL}/funnels/${funnelId}/leads/${leadId}` : null
}

// Claim a coach-notification send: UPDATE ... WHERE <column> IS NULL, so only
// the first caller to run this for a given row ever gets true back. A retry, a
// duplicate webhook, or a resubmission all find the marker already set and
// skip — the send itself never has to be idempotent, only this claim does.
async function claimCoachNotification(table: 'bookings' | 'funnel_leads', id: string, column: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from(table)
      .update({ [column]: new Date().toISOString() })
      .eq('id', id)
      .is(column, null)
      .select('id')
    if (error) {
      console.error(`[email] coach notification claim failed (${table}.${column}=${id})`, error)
      return false
    }
    return Array.isArray(data) && data.length > 0
  } catch (err) {
    console.error(`[email] coach notification claim threw (${table}.${column}=${id})`, err)
    return false
  }
}

// Coach's own configured timezone (user_availability.working_hours.timezone),
// falling back to UTC. Deliberately separate from the lead-facing booking
// confirmation's UTC label — that email is unchanged; this is only for the
// coach's own inbox.
async function coachTimeLabel(coachUserId: string, startIso: string): Promise<string> {
  const { working_hours } = await loadUserAvailability(coachUserId)
  const timeZone = working_hours.timezone || 'UTC'
  try {
    return new Date(startIso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone }) + ` (${timeZone})`
  } catch {
    return new Date(startIso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' (UTC)'
  }
}

// Coach notification when a lead books from their funnel. Best-effort BY
// CONTRACT: never throws — a mail hiccup must not fail a booking that already
// succeeded. Short, plain; includes the time (in the coach's own timezone),
// the funnel name, and a link to the lead in the builder.
// funnelId (Phase 5a): the notification is tagged and recorded, but with
// lead_id NULL by design — a coach opening their own operational notice is NOT
// lead engagement, so it must never post an email_opened onto the lead's feed.
// coachUserId (Phase 5b): the notice wears the coach's brand (it's their
// business); it stays MTM-branded only if the coach can't be resolved.
export async function sendCoachBookingNotification(opts: {
  funnel: NotifyFunnel
  bookingId: string
  leadId: string | null
  leadName: string
  leadEmail: string
  startIso: string
  answers: Array<{ label: string; answer: string }>
}): Promise<void> {
  try {
    const settings = await loadBusinessSettings(opts.funnel.user_id)
    if (!settings.notification_prefs.new_booking) return
    if (!(await claimCoachNotification('bookings', opts.bookingId, 'coach_notified_at'))) return

    const brand = await loadCoachBrand(opts.funnel.user_id)
    if (!brand.replyTo) return // no resolvable coach email — skip silently, never error the booking

    const kind = 'coach_booking_notification'
    const startLabel = await coachTimeLabel(opts.funnel.user_id, opts.startIso)
    const funnelName = funnelDisplayName(opts.funnel)
    const leadUrl = coachLeadUrl(opts.funnel.id, opts.leadId)
    const answerRows = opts.answers
      .filter((a) => a.answer)
      .map(
        (a) =>
          `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;padding:2px 12px 2px 0;vertical-align:top;">${escapeHtml(a.label)}</td><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#0B1120;padding:2px 0;">${escapeHtml(a.answer)}</td></tr>`
      )
      .join('')

    const from = `${sanitizeDisplayName(brand.businessName)} <noreply@mail.microtrainingmethod.com>`
    const bodyHtml = `
          <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(startLabel)}</p>
          <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#4B5563;">${escapeHtml(opts.leadName)} &lt;${escapeHtml(opts.leadEmail)}&gt;</p>
          <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">From ${escapeHtml(funnelName)}</p>
          ${answerRows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5E9F0;padding-top:12px;margin-top:4px;">${answerRows}</table>` : ''}
          <p style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">It's on your calendar. The lead has the meeting link.</p>`
    const html = brandedEmailHtml(brand, {
      heading: 'You have a new call booked',
      bodyHtml,
      ...(leadUrl ? { cta: { label: 'View lead in builder', url: leadUrl } } : {}),
    })

    const { data, error } = await resend.emails.send({
      from,
      to: brand.replyTo,
      subject: `New call booked — ${opts.leadName || opts.leadEmail}`,
      tags: funnelTags(opts.funnel.id, null, kind),
      html,
    })
    await recordFunnelEmailSend({
      funnelId: opts.funnel.id,
      leadId: null,
      kind,
      messageId: data?.id ?? null,
      status: error ? 'failed' : 'sent',
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] coach booking notification failed (funnel=${opts.funnel.id})`, err)
  }
}

// Coach notification when a lead submits the application gate on their funnel.
// Same best-effort contract as the booking notice above.
export async function sendCoachApplicationNotification(opts: {
  funnel: NotifyFunnel
  leadId: string
  leadName: string
  leadEmail: string
  qualified: boolean
}): Promise<void> {
  try {
    const settings = await loadBusinessSettings(opts.funnel.user_id)
    if (!settings.notification_prefs.new_application) return
    if (!(await claimCoachNotification('funnel_leads', opts.leadId, 'application_notified_at'))) return

    const brand = await loadCoachBrand(opts.funnel.user_id)
    if (!brand.replyTo) return

    const kind = 'coach_application_notification'
    const funnelName = funnelDisplayName(opts.funnel)
    const leadUrl = coachLeadUrl(opts.funnel.id, opts.leadId)
    const displayName = opts.leadName || opts.leadEmail
    const fit = opts.qualified ? 'a fit' : 'not a fit'

    const from = `${sanitizeDisplayName(brand.businessName)} <noreply@mail.microtrainingmethod.com>`
    const bodyHtml = `
          <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(displayName)} &lt;${escapeHtml(opts.leadEmail)}&gt;</p>
          <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#4B5563;">Applied on <strong>${escapeHtml(funnelName)}</strong> and looks like <strong>${fit}</strong>.</p>`
    const html = brandedEmailHtml(brand, {
      heading: 'New application submitted',
      bodyHtml,
      ...(leadUrl ? { cta: { label: 'View their answers', url: leadUrl } } : {}),
    })

    const { data, error } = await resend.emails.send({
      from,
      to: brand.replyTo,
      subject: `New application — ${displayName} (${fit})`,
      tags: funnelTags(opts.funnel.id, opts.leadId, kind),
      html,
    })
    await recordFunnelEmailSend({
      funnelId: opts.funnel.id,
      leadId: opts.leadId,
      kind,
      messageId: data?.id ?? null,
      status: error ? 'failed' : 'sent',
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] coach application notification failed (lead=${opts.leadId})`, err)
  }
}

// Coach notification when a lead opts in on their funnel's landing page.
// Default OFF (opt-ins can be high-volume) — see DEFAULT_NOTIFICATION_PREFS.
// Same best-effort contract as the two notices above.
export async function sendCoachOptinNotification(opts: {
  funnel: NotifyFunnel
  leadId: string
  leadName: string
  leadEmail: string
}): Promise<void> {
  try {
    const settings = await loadBusinessSettings(opts.funnel.user_id)
    if (!settings.notification_prefs.new_optin) return
    if (!(await claimCoachNotification('funnel_leads', opts.leadId, 'optin_notified_at'))) return

    const brand = await loadCoachBrand(opts.funnel.user_id)
    if (!brand.replyTo) return

    const kind = 'coach_optin_notification'
    const funnelName = funnelDisplayName(opts.funnel)
    const displayName = opts.leadName || opts.leadEmail

    const from = `${sanitizeDisplayName(brand.businessName)} <noreply@mail.microtrainingmethod.com>`
    const bodyHtml = `
          <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(displayName)} &lt;${escapeHtml(opts.leadEmail)}&gt;</p>
          <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#4B5563;">Just opted in on <strong>${escapeHtml(funnelName)}</strong>.</p>`
    const html = brandedEmailHtml(brand, { heading: 'New opt-in', bodyHtml })

    const { data, error } = await resend.emails.send({
      from,
      to: brand.replyTo,
      subject: `New opt-in — ${displayName}`,
      tags: funnelTags(opts.funnel.id, opts.leadId, kind),
      html,
    })
    await recordFunnelEmailSend({
      funnelId: opts.funnel.id,
      leadId: opts.leadId,
      kind,
      messageId: data?.id ?? null,
      status: error ? 'failed' : 'sent',
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] coach optin notification failed (lead=${opts.leadId})`, err)
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// One-sentence "reschedule or cancel" line for a booking email, near the join
// button. Renders nothing without a valid manage URL (e.g. the legacy path).
function manageSentence(manageUrl?: string): string {
  if (!manageUrl || !isValidHttpUrl(manageUrl)) return ''
  return `<p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">Need to change your time? You can <a href="${escapeHtml(manageUrl)}" target="_blank" style="color:#8A94A6;text-decoration:underline;">reschedule or cancel here</a>.</p>`
}

// Coach-side notice when a lead cancels or moves their own call (Phase 3b
// follow-up). Coach-branded like the booking notification; best-effort, never
// throws. Google's own attendee update (sendUpdates=all) is a second signal —
// this is our branded note to the coach.
export async function sendCoachBookingChange(opts: {
  coachEmail: string
  coachUserId?: string
  leadName: string
  leadEmail: string
  change: 'canceled' | 'moved'
  oldLabel: string
  newLabel?: string
}): Promise<void> {
  try {
    if (!opts.coachEmail) return
    const who = `${escapeHtml(opts.leadName || opts.leadEmail)} &lt;${escapeHtml(opts.leadEmail)}&gt;`
    const heading = opts.change === 'canceled' ? 'A lead canceled their call' : 'A lead moved their call'
    const subject = opts.change === 'canceled' ? `Booking canceled: ${opts.leadName || opts.leadEmail}` : `Booking moved: ${opts.leadName || opts.leadEmail}`
    const detail =
      opts.change === 'canceled'
        ? `<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">${who} canceled the call that was booked for:</p>
           <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">${escapeHtml(opts.oldLabel)}</p>
           <p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">The slot is open again and the calendar event was removed.</p>`
        : `<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#4B5563;">${who} moved their call.</p>
           <p style="margin:0 0 2px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">Was: ${escapeHtml(opts.oldLabel)}</p>
           <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#0B1120;font-weight:bold;">Now: ${escapeHtml(opts.newLabel || '')}</p>
           <p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A94A6;">Your calendar event was updated to the new time.</p>`

    const brand = opts.coachUserId ? await loadCoachBrand(opts.coachUserId) : null
    const from = brand ? `${brand.fromName} <noreply@mail.microtrainingmethod.com>` : 'Micro-Training Method <noreply@mail.microtrainingmethod.com>'
    const html = brand
      ? brandedEmailHtml(brand, { heading, bodyHtml: detail })
      : `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background-color:#F4F6F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F6F9;"><tr><td align="center" style="padding:36px 16px;"><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;"><tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E5E9F0;border-radius:14px;padding:32px;"><h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:28px;font-weight:bold;color:#0B1120;">${heading}</h1>${detail}</td></tr></table></td></tr></table></body></html>`

    const { error } = await resend.emails.send({ from, to: opts.coachEmail, subject, html })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] coach booking change failed (to=${opts.coachEmail})`, err)
  }
}

// ---- Support Desk notifications ---------------------------------------------
// Published Resend templates by alias, the same pattern as mtm-login-link —
// never inline HTML, so the copy stays editable in Resend without a deploy.
//
// Best-effort BY CONTRACT, like every other notification here: a mail failure
// must never fail the ticket write or the stage change that already succeeded.
// A member whose ticket was filed but whose confirmation bounced is recoverable;
// a 500 that loses the ticket they just typed is not.

// Plus-addressing: the ticket id rides in the reply-to address itself, so a
// member hitting reply needs no subject-line or header matching to know which
// ticket they're adding to — api/webhooks/resend.ts's email.received handler
// parses it straight back out of the `to` address of the reply.
function ticketReplyToAddress(ticketId: string): string {
  return `support+${ticketId}@mail.microtrainingmethod.com`
}

// One-time confirmation that the ticket landed. Variables: NAME, SUBJECT.
export async function sendTicketReceivedEmail(opts: {
  email: string
  name: string | null
  subject: string
  ticketId: string
}): Promise<void> {
  try {
    if (!opts.email) return
    const { error } = await resend.emails.send({
      from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
      to: opts.email,
      replyTo: ticketReplyToAddress(opts.ticketId),
      template: {
        id: 'mtm-ticket-received',
        variables: { NAME: opts.name?.trim() || 'there', SUBJECT: opts.subject },
      },
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] ticket received send failed (to=${opts.email})`, err)
  }
}

// Stage-change notice. STAGE_LABEL is the MEMBER-FACING label from
// lib/support.ts STAGE_LABELS — the caller resolves it, so a raw enum value
// like 'waiting_on_member' can never reach a member's inbox.
// Variables: NAME, SUBJECT, STAGE_LABEL.
export async function sendTicketUpdateEmail(opts: {
  email: string
  name: string | null
  subject: string
  stageLabel: string
  ticketId: string
}): Promise<void> {
  try {
    if (!opts.email) return
    const { error } = await resend.emails.send({
      from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
      to: opts.email,
      replyTo: ticketReplyToAddress(opts.ticketId),
      template: {
        id: 'mtm-ticket-update',
        variables: { NAME: opts.name?.trim() || 'there', SUBJECT: opts.subject, STAGE_LABEL: opts.stageLabel },
      },
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] ticket update send failed (to=${opts.email})`, err)
  }
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
