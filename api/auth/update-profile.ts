import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { name, profession, location, bio } = req.body || {}

  // Build the update object from only the fields present in the body
  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = name
  if (profession !== undefined) updates.profession = profession
  if (location !== undefined) updates.location = location
  if (bio !== undefined) updates.bio = bio

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' })
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', payload.userId)
      .select('id, email, name, profession, location, bio, has_paid, quiz_completed, video_watched')
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, user: data })
  } catch (err) {
    console.error('[auth/update-profile]', err)
    return res.status(500).json({ error: 'Failed to update profile' })
  }
}
