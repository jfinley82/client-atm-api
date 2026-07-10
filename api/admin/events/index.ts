import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

// Confirmed from the live Admin > Events "Add Event" form dropdown — the
// only 3 categories it actually offers, not a guess.
const EVENT_TYPES = ['Office Hours', 'Workshop', 'Live Call'] as const

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

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .order('starts_at', { ascending: true })

      if (error) throw error
      return res.status(200).json({ events: data || [] })
    } catch (err) {
      console.error('[admin/events] GET', err)
      return res.status(500).json({ error: 'Failed to load events' })
    }
  }

  if (req.method === 'POST') {
    const { title, description, event_type, starts_at, duration_minutes, meeting_link } = req.body || {}

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title required' })
    }
    if (!event_type || !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` })
    }
    if (!starts_at || typeof starts_at !== 'string' || Number.isNaN(new Date(starts_at).getTime())) {
      return res.status(400).json({ error: 'starts_at required (valid date/time)' })
    }

    try {
      const { data, error } = await supabase
        .from('events')
        .insert({
          title,
          description: description ?? null,
          event_type,
          starts_at,
          duration_minutes: duration_minutes ?? 60,
          meeting_link: meeting_link ?? null,
        })
        .select('*')
        .single()

      if (error) throw error
      return res.status(200).json({ event: data })
    } catch (err) {
      console.error('[admin/events] POST', err)
      return res.status(500).json({ error: 'Failed to create event' })
    }
  }

  return res.status(405).end()
}
