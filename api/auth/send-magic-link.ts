import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { sendMagicLinkEmail, sendWelcomeEmail } from '../../lib/email'
import { setCors } from '../../lib/cors'
import crypto from 'crypto'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email, name } = req.body || {}

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  const normalizedEmail = email.toLowerCase().trim()
  const displayName = (name || '').trim() || null

  try {
    // Upsert user
    const { data: user, error: upsertError } = await supabase
      .from('users')
      .upsert({ email: normalizedEmail, name: displayName }, { onConflict: 'email' })
      .select()
      .single()

    if (upsertError) throw upsertError

    const isNewUser = !user.created_at || 
      (Date.now() - new Date(user.created_at).getTime()) < 5000

    // Generate magic link token
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 min

    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt })

    if (tokenError) throw tokenError

    // Send email
    await sendMagicLinkEmail(normalizedEmail, displayName || '', token)
    if (isNewUser) {
      sendWelcomeEmail(normalizedEmail, displayName || '').catch(console.error)
    }

    return res.status(200).json({ ok: true, message: 'Magic link sent' })

  } catch (err) {
    console.error('[send-magic-link]', err)
    return res.status(500).json({ error: 'Failed to send magic link' })
  }
}
