import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors, noStore } from '../../lib/cors'

// POST /api/events/mark-viewed — records that the caller has just opened the
// Office Hours & Events page, clearing their nav badge.
//
// Upsert on the user_id primary key, so the row is updated in place rather
// than accumulating one per visit: the badge only ever needs the most recent
// view, and a visit log would be rows nothing reads.
//
// Same office_hours capability gate as the rest of this surface — there is no
// point recording a view of a page the member cannot open, and a member
// without the capability has no badge to clear.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (!(await requireCapability(userId, 'office_hours', res))) return

  try {
    const lastViewedAt = new Date().toISOString()
    const { error } = await supabase
      .from('event_calendar_views')
      .upsert({ user_id: userId, last_viewed_at: lastViewedAt }, { onConflict: 'user_id' })
    if (error) throw error

    return res.status(200).json({ ok: true, last_viewed_at: lastViewedAt })
  } catch (err) {
    console.error('[events/mark-viewed] POST', err)
    return res.status(500).json({ error: 'Failed to record calendar view' })
  }
}
