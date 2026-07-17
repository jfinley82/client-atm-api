import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { isZoomConfigured, getSchedulerAvailability } from '../../lib/zoom'

// GET /api/calendar/availability?from=<ISO date>&to=<ISO date>
// Public (booking a call doesn't require an account). Returns open slots in
// UTC — { slots: [{ start, end }] } — read from the host's Zoom Scheduler
// availability, minus any slot we already hold an active booking for (so a
// just-booked time disappears immediately even if Zoom's availability lags).
// The frontend renders each slot in the visitor's timezone.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  if (!isZoomConfigured()) {
    return res.status(503).json({ error: 'calendar_unavailable' })
  }

  const rawFrom = Array.isArray(req.query.from) ? req.query.from[0] : req.query.from
  const rawTo = Array.isArray(req.query.to) ? req.query.to[0] : req.query.to

  // Default window: now → +14 days. A bad date param falls back rather than 400ing.
  const now = new Date()
  const from = rawFrom && !Number.isNaN(new Date(rawFrom).getTime()) ? new Date(rawFrom) : now
  const to =
    rawTo && !Number.isNaN(new Date(rawTo).getTime())
      ? new Date(rawTo)
      : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

  try {
    const slots = await getSchedulerAvailability(from.toISOString(), to.toISOString())

    // Drop any slot we already hold an active booking for.
    const { data: booked, error } = await supabase
      .from('bookings')
      .select('start_time')
      .eq('status', 'active')
      .gte('start_time', from.toISOString())
      .lte('start_time', to.toISOString())
    if (error) throw error

    const takenMs = new Set((booked || []).map((b) => new Date(b.start_time as string).getTime()))
    const open = slots.filter((s) => !takenMs.has(new Date(s.start).getTime()))

    return res.status(200).json({ slots: open })
  } catch (err) {
    console.error('[calendar/availability] GET', err)
    return res.status(502).json({ error: 'Failed to load availability' })
  }
}
