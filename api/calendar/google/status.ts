import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'

// GET /api/calendar/google/status — authed. { connected, calendar_email? }.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { data } = await supabase
      .from('calendar_connections')
      .select('calendar_email, connected_at')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle()

    if (!data) return res.status(200).json({ connected: false })
    return res.status(200).json({
      connected: true,
      calendar_email: data.calendar_email ?? null,
      connected_at: data.connected_at ?? null,
    })
  } catch (err) {
    console.error('[calendar/google/status]', err)
    return res.status(500).json({ error: 'Failed to load status' })
  }
}
