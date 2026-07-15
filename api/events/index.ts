import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors, noStore } from '../../lib/cors'

// GET /api/events — the full events list (past and upcoming together).
// Gated by the office_hours capability (beta/full; admin bypasses) — the
// six-profile membership model makes office hours a paid-tier feature, so
// the events list is enforced server-side, not just hidden in the UI.
//
// Returns both past and upcoming events rather than splitting server-side —
// the frontend's exact "Upcoming" / "Past Events" split rule couldn't be
// confirmed (the live app 403'd on direct fetch), so each event carries
// `is_past` (starts_at + duration_minutes has already elapsed) as a
// convenience the frontend can use as-is or override with its own rule.
// `user_has_rsvpd` is included per event so "My Events" and the RSVP
// button's toggled state can be derived from this one response, no second
// round-trip to check RSVP status.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (!(await requireCapability(userId, 'office_hours', res))) return

  try {
    const [eventsRes, rsvpsRes] = await Promise.all([
      supabase.from('events').select('*').order('starts_at', { ascending: true }),
      supabase.from('event_rsvps').select('event_id').eq('user_id', userId),
    ])
    if (eventsRes.error) throw eventsRes.error
    if (rsvpsRes.error) throw rsvpsRes.error

    const rsvpdIds = new Set((rsvpsRes.data || []).map((r) => r.event_id as string))
    const now = Date.now()

    const events = (eventsRes.data || []).map((e) => {
      const endsAt = new Date(e.starts_at).getTime() + e.duration_minutes * 60_000
      return {
        id: e.id,
        title: e.title,
        description: e.description,
        event_type: e.event_type,
        starts_at: e.starts_at,
        duration_minutes: e.duration_minutes,
        meeting_link: e.meeting_link,
        is_past: endsAt < now,
        user_has_rsvpd: rsvpdIds.has(e.id),
      }
    })

    return res.status(200).json({ events })
  } catch (err) {
    console.error('[events] GET', err)
    return res.status(500).json({ error: 'Failed to load events' })
  }
}
