import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { computeOpenSlots } from '../../lib/funnelAvailability'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { rateLimit, clientIp } from '../../lib/rateLimit'

// GET /api/funnel/availability?subdomain=…&from=…&to=… — PUBLIC. Open booking
// slots for a live funnel: resolve the funnel → its owner → the owner's
// availability settings, build the working-hours grid, then subtract the owner's
// Google free/busy (when connected) and their existing active MTM bookings.
// Range is clamped to booking_window_days. Rate-limited.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const ip = clientIp(req)
  if (!rateLimit(`funnel_availability:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const subdomain = (one(req.query.subdomain) as string | undefined)?.trim() || ''
  const funnelId = (one(req.query.funnel_id) as string | undefined)?.trim() || ''
  const from = one(req.query.from) as string | undefined
  const to = one(req.query.to) as string | undefined

  if (!subdomain && !funnelId) return res.status(400).json({ error: 'subdomain or funnel_id required' })

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    // Same builder the booking's isSlotOpen uses — page and booking never drift.
    const { slots, connected } = await computeOpenSlots(funnel.user_id as string, from, to)
    // accepting_bookings distinguishes "nothing free this fortnight" from "this
    // coach never set any hours". Without it the page cannot tell them apart and
    // shows an empty calendar for both — which is how a coach with no
    // user_availability row ended up publishing default UTC office hours instead
    // of saying they were not taking bookings.
    const { configured } = await loadUserAvailability(funnel.user_id as string)
    return res.status(200).json({ slots, connected, accepting_bookings: configured })
  } catch (err) {
    console.error('[funnel/availability] GET', err)
    return res.status(500).json({ error: 'Failed to load availability' })
  }
}
