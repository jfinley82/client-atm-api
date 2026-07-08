import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// Clears the interview so a coach can start over from a blank slate. A no-op
// (still returns not_started) if no row exists yet.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { error } = await supabase
      .from('voice_guides')
      .update({ status: 'not_started', qa_log: [], guide_md: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (error) throw error

    return res.status(200).json({ status: 'not_started' })
  } catch (err) {
    console.error('[voice-guide/reset] POST', err)
    return res.status(500).json({ error: 'Failed to reset voice guide' })
  }
}
