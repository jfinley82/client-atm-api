import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'

// GET /api/funnels/[id]/video-analytics — owner-scoped video drop-off for the
// dashboard's Video Performance panel. A SIBLING to analytics.ts (not an
// extension) so that endpoint's response stays byte-for-byte backward compatible.
//
// plays        = training_view count (top of the video funnel).
// video_sessions = distinct viewing sessions that hit any milestone (= reached 25).
// milestones   = each session reduced to its FURTHEST percent, so reaching 75
//                implies 25 and 50 — a clean monotonic drop-off (25 → 50 → 75 → 100).
// completion_rate  = sessions that finished / sessions that started the video.
// play_through_rate = sessions that started the video / plays.
const MILESTONES = [25, 50, 75, 100]

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const funnel = await getOwnedFunnel(userId, id)
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  try {
    const [playsRes, eventsRes] = await Promise.all([
      supabase
        .from('funnel_events')
        .select('*', { count: 'exact', head: true })
        .eq('funnel_id', id)
        .eq('event_type', 'training_view'),
      supabase
        .from('funnel_events')
        .select('metadata')
        .eq('funnel_id', id)
        .in('event_type', ['video_watched', 'video_completed']),
    ])

    const plays = playsRes.count ?? 0

    // Reduce every video beacon to each session's furthest percent. Anonymous
    // rows with no session_id can't be tied to a viewing session, so they don't
    // enter the drop-off (they'd double-count); plays remains the honest top.
    const furthest = new Map<string, number>()
    for (const row of (eventsRes.data as { metadata: unknown }[]) || []) {
      const m = (row?.metadata || {}) as { session_id?: unknown; percent?: unknown }
      const sid = typeof m.session_id === 'string' && m.session_id ? m.session_id : null
      const pct = Number(m.percent)
      if (!sid || !Number.isFinite(pct)) continue
      if (pct > (furthest.get(sid) ?? 0)) furthest.set(sid, pct)
    }

    const video_sessions = furthest.size
    const reached: Record<number, number> = { 25: 0, 50: 0, 75: 0, 100: 0 }
    for (const f of furthest.values()) {
      for (const m of MILESTONES) if (f >= m) reached[m]++
    }

    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0)

    const milestones = MILESTONES.map((m) => ({
      pct: m,
      count: reached[m],
      // Share of viewing sessions reaching this milestone (25 is 1.0 by construction).
      rate: rate(reached[m], video_sessions),
    }))

    return res.status(200).json({
      plays,
      video_sessions,
      milestones,
      completion_rate: rate(reached[100], video_sessions),
      play_through_rate: rate(video_sessions, plays),
    })
  } catch (err) {
    console.error('[funnels/[id]/video-analytics] GET', err)
    return res.status(500).json({ error: 'Failed to load video analytics' })
  }
}
