import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'

// POST   /api/events/{id}/rsvp — records the member's RSVP for one event.
// DELETE /api/events/{id}/rsvp — cancels it.
//
// Both are idempotent, deliberately and symmetrically. POST upserts on the
// (user_id, event_id) unique constraint; DELETE removes the row if it is
// there and shrugs if it is not. So a double-click, or a retry after a flaky
// network call, is a harmless no-op in either direction and the frontend
// needs no idempotency guard of its own — which is the bug this route
// originally replaced.
//
// A missing RSVP on DELETE is NOT a 404: the caller asked for "no RSVP" and
// that is the state they end up in, so it succeeded. 404 is reserved for the
// event itself not existing, matching POST.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const isDelete = req.method === 'DELETE'
  if (req.method !== 'POST' && !isDelete) return res.status(405).end()

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

    if (isDelete) {
      // Scoped to the caller's own row — an event id alone must never be able
      // to cancel somebody else's RSVP.
      const { error } = await supabase.from('event_rsvps').delete().eq('user_id', userId).eq('event_id', eventId)
      if (error) throw error
      return res.status(200).json({ ok: true, rsvpd: false })
    }

    const { error } = await supabase
      .from('event_rsvps')
      .upsert({ user_id: userId, event_id: eventId }, { onConflict: 'user_id,event_id' })
    if (error) throw error

    return res.status(200).json({ ok: true, rsvpd: true })
  } catch (err) {
    console.error(`[events/rsvp] ${req.method}`, err)
    return res.status(500).json({ error: isDelete ? 'Failed to cancel RSVP' : 'Failed to RSVP' })
  }
}
