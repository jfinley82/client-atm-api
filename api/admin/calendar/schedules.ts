import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { isZoomConfigured, listSchedules } from '../../../lib/zoom'

// GET /api/admin/calendar/schedules — admin-gated. Lists the account's Zoom
// Scheduler schedules (id + name) so the admin can pick the one to set as
// ZOOM_SCHEDULE_ID (which the availability endpoint reads from). Needs the
// scheduler:read:list_schedules:admin scope on the Zoom app.
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

  if (!isZoomConfigured()) {
    return res.status(503).json({ error: 'calendar_unavailable' })
  }

  try {
    const schedules = await listSchedules()
    return res.status(200).json({ schedules })
  } catch (err) {
    console.error('[admin/calendar/schedules] GET', err)
    return res.status(502).json({ error: 'Failed to load schedules' })
  }
}
