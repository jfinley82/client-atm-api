import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireActiveUser } from '../../lib/auth'
import { loadUserAvailability, validateSettingsInput } from '../../lib/availabilitySettings'

// GET/PATCH /api/calendar/availability-settings — the coach's per-account
// availability settings (working_hours + slot/buffer/window). Authed. PATCH (not
// PUT) because lib/cors Allow-Methods lists PATCH, not PUT — a PUT preflight
// would be blocked cross-origin. PATCH is also the repo convention.
//
// NOTE ON PATH: the spec named GET/PUT /api/calendar/availability, but that path
// is already the LIVE public Zoom availability endpoint the funnel book page
// depends on. To avoid a breaking collision, the coach settings live here. The
// new PUBLIC per-funnel availability is the separate /api/funnel/availability.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    noStore(res)
    try {
      const settings = await loadUserAvailability(userId)
      return res.status(200).json({ settings })
    } catch (err) {
      console.error('[calendar/availability-settings] GET', err)
      return res.status(500).json({ error: 'Failed to load settings' })
    }
  }

  if (req.method === 'PATCH') {
    const parsed = validateSettingsInput(req.body)
    if (!parsed.ok) {
      return res.status(400).json({ error: 'invalid_field', field: parsed.field })
    }
    try {
      const { error } = await supabase.from('user_availability').upsert(
        { user_id: userId, ...parsed.update, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      if (error) throw error
      const settings = await loadUserAvailability(userId)
      return res.status(200).json({ settings })
    } catch (err) {
      console.error('[calendar/availability-settings] PUT', err)
      return res.status(500).json({ error: 'Failed to save settings' })
    }
  }

  return res.status(405).end()
}
