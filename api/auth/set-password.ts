import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { password } = req.body || {}

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  try {
    const password_hash = await bcrypt.hash(password, 12)

    const { error } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', userId)

    if (error) throw error

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[auth/set-password]', err)
    return res.status(500).json({ error: 'Failed to set password' })
  }
}
