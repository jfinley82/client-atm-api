import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { isZoomConfigured } from '../../lib/zoom'
import { listOpenSchedulerSlots } from '../../lib/schedulerSlots'

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
    // Shared with POST /api/calendar/book's validation (lib/schedulerSlots.ts):
    // the list the page renders and the check that accepts a booking are the
    // same computation, so a listed slot always books.
    const open = await listOpenSchedulerSlots(from.toISOString(), to.toISOString())

    return res.status(200).json({ slots: open })
  } catch (err) {
    console.error('[calendar/availability] GET', err)
    return res.status(502).json({ error: 'Failed to load availability' })
  }
}
