import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'
import { sendBetaWelcomeEmail } from '../../lib/email'
import { INVITE_TTL_MS } from '../../lib/tokenLifetimes'
import { requireWebhookSecret } from '../../lib/webhookAuth'

// The API's own public base URL — the invite email's login link must hit the
// BACKEND magic-token processor (GET /api/auth/callback), same as
// sendMagicLinkEmail in lib/email.ts. The frontend has no /auth/callback
// route, so an APP_URL-based link 404s.
const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  // Refuses when WEBHOOK_SECRET is unset instead of comparing undefined to
  // undefined and letting everyone through. See lib/webhookAuth.ts.
  if (!requireWebhookSecret(req, res, 'members/invite-beta')) return

  const body = req.body || {}
  const email = body.customData?.email || body.email
  const first_name = body.customData?.first_name || body.first_name
  const last_name = body.customData?.last_name || body.last_name
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }

  const normalizedEmail = email.toLowerCase().trim()
  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null

  try {
    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        {
          email: normalizedEmail,
          name,
          // 'beta' since the six-profile model — same capabilities as full
          // today, but beta invitees stay distinguishable from $1497 buyers.
          // (Was hardcoded 'full' from before the beta tier existed.)
          membership_tier: 'beta',
          invited_as_beta: true,
          status: 'active',
        },
        { onConflict: 'email' }
      )
      .select('id, name, email, membership_tier, status')
      .single()

    if (error) throw error

    // An INVITE, not a login link — this is the flow the kind column was added
    // for, and it has minted 7-day tokens since before that column existed.
    // The lifetime now comes from lib/tokenLifetimes.ts so it is tuned in one
    // place alongside admin-issued invites.
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()

    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt, kind: 'invite' })

    if (tokenError) throw tokenError

    const login_url = `${API_URL}/api/auth/callback?token=${encodeURIComponent(token)}`

    await sendBetaWelcomeEmail(normalizedEmail, user.name || '', login_url)

    return res.status(200).json({
      success: true,
      user_id: user.id,
      email: user.email,
      membership_tier: user.membership_tier,
      status: user.status,
      login_url,
    })
  } catch (err) {
    console.error('[members/invite-beta]', err)
    return res.status(500).json({ error: 'Failed to invite beta member' })
  }
}
