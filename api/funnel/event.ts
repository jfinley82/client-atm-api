import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { verifyWatchToken } from '../../lib/funnelLeadToken'

// POST /api/funnel/event — PUBLIC, client-reported funnel engagement beacons.
//
// The ONLY event types a client may post are the two video milestones. Every
// other funnel_events type (landing_view/training_view/signup/booking_click/
// booked/closed) is written SERVER-side and is rejected here, so a client can
// never forge a page view or a conversion through this path.
//
// Body: { subdomain?|funnel_id?, event_type, watch_token?, session_id?, percent? }
//  - event_type ∈ { video_watched (25|50|75), video_completed (→100) } — strict.
//  - watch_token (issued at opt-in) attributes the event to a lead of THIS funnel;
//    tampered/expired/foreign → lead_id null (the watch still counts at the funnel
//    level). It only NAMES a lead — it grants nothing.
//  - percent is validated against the type so a client can't post an off-milestone
//    value to skew the drop-off funnel.
//  - Dedup: one row per (funnel, session_id, percent) via a unique index; a replay
//    is a benign 200 so counts can't be inflated.
const CLIENT_EVENT_TYPES = new Set(['video_watched', 'video_completed'])
const WATCHED_PERCENTS = new Set([25, 50, 75])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const ip = clientIp(req)
  // Generous cap: a session emits at most 4 milestones, but one IP (shared NAT)
  // can carry many viewers. Best-effort abuse blunting, not a hard quota.
  if (!rateLimit(`funnel_event:${ip}`, 60, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const eventType = typeof body.event_type === 'string' ? body.event_type.trim() : ''
  const subdomain = typeof body.subdomain === 'string' ? body.subdomain.trim() : ''
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''
  const watchToken = typeof body.watch_token === 'string' ? body.watch_token : ''
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim().slice(0, 100) : ''

  // Strict client allowlist — the whole point of this endpoint's safety.
  if (!CLIENT_EVENT_TYPES.has(eventType)) {
    return res.status(400).json({ error: 'invalid_event_type' })
  }
  if (!subdomain && !funnelId) {
    return res.status(400).json({ error: 'subdomain or funnel_id required' })
  }

  // percent must be consistent with the type: video_completed always means 100
  // (client percent ignored); video_watched must be one of the real milestones.
  let percent: number
  if (eventType === 'video_completed') {
    percent = 100
  } else {
    const raw = typeof body.percent === 'number' ? body.percent : Number(body.percent)
    percent = Number.isFinite(raw) ? Math.floor(raw) : NaN
    if (!WATCHED_PERCENTS.has(percent)) {
      return res.status(400).json({ error: 'invalid_percent' })
    }
  }

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    // Attribute to a lead only when the signed token resolves AND that lead still
    // belongs to this funnel (the FK would reject a stale id anyway). Else null.
    let leadId: string | null = null
    if (watchToken) {
      const tokenLead = verifyWatchToken(watchToken, funnel.id as string)
      if (tokenLead) {
        const { data: leadRow } = await supabase
          .from('funnel_leads')
          .select('id')
          .eq('id', tokenLead)
          .eq('funnel_id', funnel.id)
          .maybeSingle()
        if (leadRow) leadId = tokenLead
      }
    }

    const { error } = await supabase.from('funnel_events').insert({
      funnel_id: funnel.id,
      lead_id: leadId,
      event_type: eventType,
      metadata: { session_id: sessionId || null, percent },
    })

    // 23505 = the dedup unique index → a replayed milestone. Benign, still 200.
    if (error && (error as { code?: string }).code !== '23505') {
      console.error('[funnel/event] insert', error)
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    // Beacons are fire-and-forget from the player; never surface a hard failure.
    console.error('[funnel/event] POST', err)
    return res.status(200).json({ ok: true })
  }
}
