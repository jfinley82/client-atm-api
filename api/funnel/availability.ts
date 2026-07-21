import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { loadUserAvailability } from '../../lib/availabilitySettings'
import { generateGridSlots, subtractBusy, clampWindow, Interval } from '../../lib/availability'
import { getValidAccessToken, fetchFreeBusy } from '../../lib/googleCalendar'
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

    const owner = funnel.user_id as string
    const settings = await loadUserAvailability(owner)

    const window = clampWindow(from, to, settings.booking_window_days, Date.now())
    if (!window) return res.status(200).json({ slots: [], connected: false })

    const grid = generateGridSlots(
      settings.working_hours,
      settings.slot_minutes,
      settings.buffer_minutes,
      window.from,
      window.to
    )

    const busy: Interval[] = []

    // Google free/busy when the owner has connected — best-effort. On any Google
    // error we fall back to bookings-only rather than failing the page.
    const conn = await getValidAccessToken(owner)
    if (conn) {
      try {
        const gbusy = await fetchFreeBusy(conn.access_token, conn.calendar_id, window.from, window.to)
        busy.push(...gbusy)
      } catch (gErr) {
        console.error('[funnel/availability] freeBusy failed, bookings-only', gErr)
      }
    }

    // The owner's existing active MTM bookings in the window.
    const { data: bookings } = await supabase
      .from('bookings')
      .select('start_time, end_time')
      .eq('coach_user_id', owner)
      .eq('status', 'active')
      .lt('start_time', window.to)
      .gt('end_time', window.from)
    for (const b of bookings || []) {
      if (typeof b.start_time === 'string' && typeof b.end_time === 'string') {
        busy.push({ start: b.start_time, end: b.end_time })
      }
    }

    const slots = subtractBusy(grid, busy)
    return res.status(200).json({ slots, connected: !!conn })
  } catch (err) {
    console.error('[funnel/availability] GET', err)
    return res.status(500).json({ error: 'Failed to load availability' })
  }
}
