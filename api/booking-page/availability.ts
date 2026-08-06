import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { computeOpenSlots } from '../../lib/funnelAvailability'
import { hasConfiguredAvailability, resolveBookingSlug } from '../../lib/bookingPage'
import { loadUserAvailability } from '../../lib/availabilitySettings'

// GET /api/booking-page/availability?slug=…&from=…&to=… — PUBLIC.
//
// Resolves the slug to a coach and answers from computeOpenSlots — the SAME
// builder isSlotOpen uses when the booking is validated, so the list a stranger
// picks from and the check that accepts their pick cannot drift. Every
// slot_taken outage on the funnel path came from breaking that.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const ip = clientIp(req)
  if (!rateLimit(`booking_page_availability:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const slug = one(req.query?.slug) as string | undefined
  const from = one(req.query?.from) as string | undefined
  const to = one(req.query?.to) as string | undefined
  if (!slug) return res.status(400).json({ error: 'slug required' })

  try {
    const owner = await resolveBookingSlug(slug)
    if (!owner) return res.status(404).json({ error: 'not_found' })

    // A coach who has never configured availability would otherwise be served
    // DEFAULT_WORKING_HOURS — 9 to 5 weekdays in UTC — and a stranger could book
    // hours they never chose. Answer empty and say why, rather than publishing a
    // calendar built out of defaults.
    if (!(await hasConfiguredAvailability(owner.userId))) {
      const settings = await loadUserAvailability(owner.userId)
      return res.status(200).json({
        slots: [],
        connected: false,
        accepting_bookings: false,
        from: null,
        to: null,
        window_days: settings.booking_window_days,
      })
    }

    const settings = await loadUserAvailability(owner.userId)
    const { slots, connected } = await computeOpenSlots(owner.userId, from, to)

    // The SERVED window is echoed, not the requested one, so the calendar bounds
    // itself by what came back — the lesson from the availability endpoint that
    // returned 45 days to a caller asking for 60 and left it looking empty
    // afterwards. window_days is the coach's own booking_window_days, which is
    // what actually decides how far the calendar may page.
    return res.status(200).json({
      slots,
      connected,
      accepting_bookings: true,
      from: slots.length ? slots[0].start : null,
      to: slots.length ? slots[slots.length - 1].start : null,
      window_days: settings.booking_window_days,
    })
  } catch (err) {
    console.error('[booking-page/availability] GET', err)
    return res.status(500).json({ error: 'Failed to load availability' })
  }
}
