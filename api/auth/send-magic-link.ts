import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { sendMagicLinkEmail } from '../../lib/email'
import { setCors } from '../../lib/cors'
import crypto from 'crypto'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email } = req.body || {}

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  const normalizedEmail = email.toLowerCase().trim()

  try {
    // Lookup only — do not create new users from this endpoint
    const { data: user } = await supabase
      .from('users')
      .select('id, name, has_paid, status')
      .eq('email', normalizedEmail)
      .maybeSingle()

    // Block suspended accounts — never issue a login token for them
    if (user && user.status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' })
    }

    // Silently no-op for unknown emails or unpaid users.
    // Same response in all cases so callers can't probe membership/paid status.
    if (!user || !user.has_paid) {
      return res.status(200).json({ ok: true })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 min

    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt })

    if (tokenError) throw tokenError

    await sendMagicLinkEmail(normalizedEmail, user.name || '', token)

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[send-magic-link]', err)
    return res.status(500).json({ error: 'Failed to send magic link' })
  }
}
