import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (setCors(req, res)) return

    if (req.method !== 'GET') return res.status(405).end()

    const sessionToken = getSessionFromRequest(req as any)
    if (!sessionToken) return res.status(401).json({ user: null })

    const payload = await verifySessionToken(sessionToken)
    if (!payload) return res.status(401).json({ user: null })

    const [{ data: user, error }, { data: scheduleRows }] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, name, has_paid, quiz_completed, quiz_score, video_watched, membership_tier, status, created_at')
        .eq('id', payload.userId)
        .single(),
      supabase
        .from('unlock_schedule')
        .select('item_key, unlock_at')
    ])

    if (error || !user) return res.status(401).json({ user: null })

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' })
    }

    const schedule: Record<string, string | null> = {}
    for (const row of scheduleRows || []) {
      schedule[row.item_key] = row.unlock_at
    }

    return res.status(200).json({ user, schedule })
  } catch (err: any) {
    console.error('CRASH:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
