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

  try {
    const { error } = await supabase
      .from('users')
      .update({ video_watched: true })
      .eq('id', payload.userId)

    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[progress/watch-training]', err)
    return res.status(500).json({ error: 'Failed to update progress' })
  }
}
