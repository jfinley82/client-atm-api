import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'

// GET /api/admin/calendar/bookings — admin-gated list of all bookings for the
// host, newest start first. Read-only.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('id, user_id, name, email, zoom_meeting_id, zoom_join_url, start_time, end_time, status, created_at')
      .order('start_time', { ascending: false })
      .limit(500)

    if (error) throw error
    return res.status(200).json({ bookings: data || [] })
  } catch (err) {
    console.error('[admin/calendar/bookings] GET', err)
    return res.status(500).json({ error: 'Failed to load bookings' })
  }
}
