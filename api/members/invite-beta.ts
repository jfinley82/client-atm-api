import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'
import { sendBetaWelcomeEmail } from '../../lib/email'

const APP_URL = process.env.APP_URL || 'https://app.clientatmbuilder.com'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { email, first_name, last_name } = req.body || {}
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
          membership_tier: 'full',
          invited_as_beta: true,
          status: 'active',
        },
        { onConflict: 'email' }
      )
      .select('id, name')
      .single()

    if (error) throw error

    // Issue a login token (valid 7 days) so the invite link works without a password
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt })

    if (tokenError) throw tokenError

    const login_url = `${APP_URL}/auth/callback?token=${encodeURIComponent(token)}`

    await sendBetaWelcomeEmail(normalizedEmail, user.name || '', login_url)

    return res.status(200).json({ success: true, login_url })
  } catch (err) {
    console.error('[members/invite-beta]', err)
    return res.status(500).json({ error: 'Failed to invite beta member' })
  }
}
