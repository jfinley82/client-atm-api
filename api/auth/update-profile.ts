import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { name, business_name, bio, avatar_url } = req.body || {}

  // Only allow updating the fields we expose; ignore anything else in the body.
  const updates: Record<string, string | null> = {}

  for (const [key, value] of Object.entries({ name, business_name, bio, avatar_url })) {
    if (value === undefined) continue
    if (value !== null && typeof value !== 'string') {
      return res.status(400).json({ error: `${key} must be a string or null` })
    }
    updates[key] = value
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No profile fields to update' })
  }

  if (typeof updates.name === 'string' && updates.name.trim().length === 0) {
    return res.status(400).json({ error: 'name cannot be empty' })
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', payload.userId)
      .select('id, email, name, business_name, bio, avatar_url, has_paid, quiz_completed, quiz_score, created_at')
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, user: data })
  } catch (err) {
    console.error('[auth/update-profile]', err)
    return res.status(500).json({ error: 'Failed to update profile' })
  }
}
