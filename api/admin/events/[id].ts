import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

// Confirmed from the live Admin > Events "Add Event" form dropdown — the
// only 3 categories it actually offers, not a guess.
const EVENT_TYPES = ['Office Hours', 'Workshop', 'Live Call'] as const

// Fields an admin may update on an event
const UPDATABLE_FIELDS = ['title', 'description', 'event_type', 'starts_at', 'duration_minutes', 'meeting_link'] as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

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

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    const body = req.body || {}

    if ('event_type' in body && !EVENT_TYPES.includes(body.event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` })
    }
    if ('starts_at' in body && (typeof body.starts_at !== 'string' || Number.isNaN(new Date(body.starts_at).getTime()))) {
      return res.status(400).json({ error: 'starts_at must be a valid date/time' })
    }

    const updates: Record<string, unknown> = {}
    for (const field of UPDATABLE_FIELDS) {
      if (field in body) updates[field] = body[field]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' })
    }

    try {
      const { data, error } = await supabase
        .from('events')
        .update(updates)
        .eq('id', id)
        .select('*')
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Event not found' })

      return res.status(200).json({ event: data })
    } catch (err) {
      console.error('[admin/events/[id]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update event' })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { data, error } = await supabase
        .from('events')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Event not found' })

      return res.status(200).json({ success: true })
    } catch (err) {
      console.error('[admin/events/[id]] DELETE', err)
      return res.status(500).json({ error: 'Failed to delete event' })
    }
  }

  return res.status(405).end()
}
