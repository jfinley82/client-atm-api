import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'

// POST /api/events/{id}/rsvp — records the member's RSVP for one event.
// Upserts on the (user_id, event_id) unique constraint, so calling this
// twice for the same event is a harmless no-op rather than a duplicate-row
// error — matches the false-success-toast bug this replaces: the frontend
// can now safely retry without needing its own idempotency guard.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Office hours are a beta/full capability (admin bypasses) — enforced here,
  // not just hidden in the UI, same as the events list.
  if (!(await requireCapability(userId, 'office_hours', res))) return

  const rawId = req.query.id
  const eventId = Array.isArray(rawId) ? rawId[0] : rawId
  if (!eventId || typeof eventId !== 'string') {
    return res.status(400).json({ error: 'event_id required' })
  }

  try {
    const { data: event, error: eventErr } = await supabase
      .from('events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle()
    if (eventErr) throw eventErr
    if (!event) return res.status(404).json({ error: 'Event not found' })

    const { error } = await supabase
      .from('event_rsvps')
      .upsert({ user_id: userId, event_id: eventId }, { onConflict: 'user_id,event_id' })
    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[events/rsvp] POST', err)
    return res.status(500).json({ error: 'Failed to RSVP' })
  }
}
