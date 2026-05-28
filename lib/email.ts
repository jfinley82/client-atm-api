import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)
const FROM = 'Client ATM Builder <noreply@clientatmbuilder.com>'
const APP_URL = process.env.APP_URL || 'https://app.clientatmbuilder.com'

export async function sendMagicLinkEmail(email: string, name: string, token: string) {
  const link = `${APP_URL}/auth/callback?token=${encodeURIComponent(token)}`

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Your Client ATM Builder Login Link',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Inter', sans-serif; background: #0a0e1a; color: #f1f5f9; padding: 40px 20px; margin: 0;">
        <div style="max-width: 560px; margin: 0 auto; background: #0f172a; border: 1px solid rgba(148,163,184,0.15); border-radius: 16px; padding: 40px;">
          <h2 style="color: #a855f7; font-size: 24px; margin: 0 0 8px;">Client ATM Builder</h2>
          <p style="color: rgba(241,245,249,0.6); margin: 0 0 32px; font-size: 14px;">The A.T.M. Method for Coaches &amp; Consultants</p>
          <p style="font-size: 16px; margin: 0 0 8px;">Hey ${name || 'there'},</p>
          <p style="color: rgba(241,245,249,0.7); margin: 0 0 32px;">Click the button below to log in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${link}" style="display: inline-block; background: linear-gradient(to right, #9333ea, #7c3aed); color: white; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 16px;">Log In to Your Dashboard →</a>
          <p style="color: rgba(241,245,249,0.3); font-size: 12px; margin: 32px 0 0;">If you didn't request this, you can safely ignore it. This link will expire on its own.</p>
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
