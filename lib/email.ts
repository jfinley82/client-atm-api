import { Resend } from 'resend'
import crypto from 'crypto'
import { supabase } from './supabase'

const resend = new Resend(process.env.RESEND_API_KEY!)
const FROM = 'Client ATM Builder <noreply@clientatmbuilder.com>'
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

// Booking confirmation with the Zoom join link and an attached .ics so the
// meeting lands on the customer's calendar. Best-effort BY CONTRACT: never
// throws — a mail hiccup must not fail a booking that already succeeded (the
// Zoom meeting exists and the row is stored either way). Inline branded HTML
// (no dedicated template alias for this yet), MTM light theme, from the
// verified MTM domain. startLocalLabel is a human-readable time string the
// caller formats; the .ics carries the authoritative UTC times.
export async function sendBookingConfirmationEmail(opts: {
  email: string
  name: string | null
  startLabel: string
  joinUrl: string
  icsContent: string
}): Promise<void> {
  try {
    const { error } = await resend.emails.send({
      from: 'Micro-Training Method <noreply@mail.microtrainingmethod.com>',
      to: opts.email,
      subject: 'Your call is booked',
      attachments: [{ filename: 'invite.ics', content: Buffer.from(opts.icsContent) }],
      html: `<!DOCTYPE html>
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
          <p style="margin:0 0 14px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#4B5563;">Hey ${opts.name || 'there'},</p>
          <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#4B5563;">You're all set. Here are the details:</p>
          <p style="margin:0 0 26px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#0B1120; font-weight:bold;">${opts.startLabel}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="#5FA828" style="background-color:#5FA828; border-radius:10px;">
              <a href="${opts.joinUrl}" target="_blank" style="display:inline-block; padding:14px 30px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; color:#FFFFFF; text-decoration:none; border-radius:10px;">Join the call</a>
            </td>
          </tr></table>
          <p style="margin:26px 0 6px; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; color:#8A94A6;">Or paste this link into your browser:</p>
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; word-break:break-all;"><a href="${opts.joinUrl}" target="_blank" style="color:#3B7A16; text-decoration:none;">${opts.joinUrl}</a></p>
          <p style="margin:24px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px; color:#8A94A6;">The attached calendar file will add this to your calendar.</p>
        </td></tr>
        <tr><td style="padding-top:24px; padding-left:8px;">
          <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:20px; color:#98A2B3;">Micro-Training Method</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error(`[email] booking confirmation send failed (to=${opts.email})`, err)
  }
}

export async function sendBetaWelcomeEmail(email: string, name: string, loginUrl: string) {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "You're in — welcome to the beta 🎯",
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Inter', sans-serif; background: #0a0e1a; color: #f1f5f9; padding: 40px 20px; margin: 0;">
        <div style="max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid rgba(148,163,184,0.15); border-radius: 16px; padding: 40px;">
          <h2 style="color: #a855f7; font-size: 24px; margin: 0 0 8px;">Welcome to the beta, ${name || 'Coach'}! 🎯</h2>
          <p style="color: rgba(241,245,249,0.7); margin: 0 0 32px;">You've been given full access. Click below to log in and get started — no password needed.</p>
          <a href="${loginUrl}" style="display: inline-block; background: linear-gradient(to right, #9333ea, #7c3aed); color: white; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 16px;">Log In to Your Dashboard →</a>
          <p style="color: rgba(241,245,249,0.3); font-size: 12px; margin: 32px 0 0;">If the button doesn't work, copy and paste this link:<br>${loginUrl}</p>
        </div>
      </body>
      </html>
    `
  })
}

export async function sendWelcomeEmail(email: string, name: string) {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Welcome to Client ATM Builder 🎯',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Inter', sans-serif; background: #0a0e1a; color: #f1f5f9; padding: 40px 20px; margin: 0;">
        <div style="max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid rgba(148,163,184,0.15); border-radius: 16px; padding: 40px;">
          <h2 style="color: #a855f7;">Welcome, ${name || 'Coach'}! 🎯</h2>
          <p>You're in. The Client ATM Builder is ready for you.</p>
          <p style="color: rgba(241,245,249,0.7);">Here's what to do next:</p>
          <ol style="color: rgba(241,245,249,0.7); padding-left: 20px; line-height: 2;">
            <li>Take the A.T.M. Quiz to set your baseline</li>
            <li>Run through the 3 AI tools (Audience → Transformation → Monetization)</li>
            <li>Download your complete Client ATM Blueprint</li>
          </ol>
          <p style="color: rgba(241,245,249,0.3); font-size: 12px; margin-top: 32px;">© 2026 Clarity &amp; Clients · support@clarityandclients.com</p>
        </div>
      </body>
      </html>
    `
  })
}
