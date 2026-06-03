import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', payload.userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    // Never select password_hash
    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, profession, has_paid, quiz_completed, video_watched, role, created_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({ members: data || [] })
  } catch (err) {
    console.error('[admin/members]', err)
    return res.status(500).json({ error: 'Failed to load members' })
  }
}
