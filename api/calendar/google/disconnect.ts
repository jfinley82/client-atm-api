import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'

// DELETE /api/calendar/google/disconnect — authed. Removes the coach's Google
// calendar connection (tokens included). Idempotent.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'DELETE') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { error } = await supabase
      .from('calendar_connections')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'google')
    if (error) throw error
    return res.status(200).json({ disconnected: true })
  } catch (err) {
    console.error('[calendar/google/disconnect]', err)
    return res.status(500).json({ error: 'Failed to disconnect' })
  }
}
