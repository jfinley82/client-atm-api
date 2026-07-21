import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { rateLimit, clientIp } from '../../lib/rateLimit'

// POST /api/funnel/event — PUBLIC event beacon fired by the live funnel pages
// for the client-side events the server can't observe on a page load. Today
// that's 'booked' (fired after a successful native-calendar booking on the book
// page). Page-view events (landing_view / training_view / booking_click) are
// logged server-side by the renderer, and 'signup' by the lead endpoint; those
// are NOT accepted here.
//
// Body: { subdomain? , funnel_id?, event_type, lead_id? }
const CLIENT_EVENTS = new Set(['booked'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const ip = clientIp(req)
  if (!rateLimit(`funnel_event:${ip}`, 20, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const eventType = typeof body.event_type === 'string' ? body.event_type : ''
  const subdomain = typeof body.subdomain === 'string' ? body.subdomain.trim() : ''
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''
  const leadId = typeof body.lead_id === 'string' && body.lead_id.trim() ? body.lead_id.trim() : null

  if (!CLIENT_EVENTS.has(eventType)) {
    return res.status(400).json({ error: 'invalid_event_type' })
  }
  if (!subdomain && !funnelId) {
    return res.status(400).json({ error: 'subdomain or funnel_id required' })
  }

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    const { error } = await supabase
      .from('funnel_events')
      .insert({ funnel_id: funnel.id, lead_id: leadId, event_type: eventType })
    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[funnel/event] POST', err)
    return res.status(500).json({ error: 'Failed to log event' })
  }
}
