import { supabase } from './supabase'

// Shared "how far did each viewing session get" reducer, backing both
// api/funnels/[id]/video-analytics.ts (the full drop-off breakdown) and the
// Overview's funnel-flow "watched" step (api/funnels/[id]/analytics.ts) — ONE
// implementation, so the two never drift into disagreeing about what
// "watched" means.
//
// Every funnel_events row for 'video_watched'/'video_completed' carries a
// session_id + percent in its metadata; reduced to each session's FURTHEST
// percent (reaching 75 implies 25 and 50). Anonymous rows with no session_id
// can't be tied to a session, so they're excluded rather than double-counted.
export async function loadFurthestPercentBySession(funnelId: string): Promise<Map<string, number>> {
  const { data } = await supabase
    .from('funnel_events')
    .select('metadata')
    .eq('funnel_id', funnelId)
    .in('event_type', ['video_watched', 'video_completed'])

  const furthest = new Map<string, number>()
  for (const row of (data as { metadata: unknown }[]) || []) {
    const m = (row?.metadata || {}) as { session_id?: unknown; percent?: unknown }
    const sid = typeof m.session_id === 'string' && m.session_id ? m.session_id : null
    const pct = Number(m.percent)
    if (!sid || !Number.isFinite(pct)) continue
    if (pct > (furthest.get(sid) ?? 0)) furthest.set(sid, pct)
  }
  return furthest
}

// "Watched" = the session started the video AND reached the first tracking
// milestone (25%) — a training_view (page load) alone does not count; a
// visitor who bounced before the video played past its opening seconds never
// really watched it.
export async function countWatched(funnelId: string): Promise<number> {
  const furthest = await loadFurthestPercentBySession(funnelId)
  let watched = 0
  for (const f of furthest.values()) if (f >= 25) watched++
  return watched
}
