import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { buildPublicBookingPage, resolveBookingHost } from '../../lib/bookingPage'

// GET /api/booking-page[?slug=…] — PUBLIC. Everything the coach's own booking
// page renders, in one call rather than three.
//
// THE SLUG IS OPTIONAL. With one, that coach. Without one, MTM's own booking
// host, named by the booking_host_slug app setting — that is what MTM's internal
// book-a-call page uses, since its URL carries no slug.
//
// Both cases go through resolveBookingHost and produce the same payload, so
// there is nothing here that branches on which one happened. The response
// includes `slug`, so a caller that arrived without one leaves knowing which
// coach it got and can address the availability and booking endpoints normally.
//
// Rate-limited like api/funnel/availability.ts: this is an unauthenticated
// endpoint that reads the database on every hit and takes an attacker-supplied
// key, so it is also a slug-enumeration surface.
//
// 404 on an unknown slug, on a slug that resolves to a coach who has not
// configured anything, and on an unset or unresolvable booking_host_slug. Never
// distinguish "exists but unconfigured" from "does not exist" — the difference
// is only useful to someone probing for which slugs are taken.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const ip = clientIp(req)
  if (!rateLimit(`booking_page:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  try {
    const owner = await resolveBookingHost(req.query?.slug)
    // An invalid slug, an unclaimed one, and an unset booking_host_slug all
    // answer identically: a malformed slug is not a different fact about the
    // world, it is just not a page. And a host we cannot name is not a host we
    // may guess at — see resolveBookingHost.
    if (!owner) return res.status(404).json({ error: 'not_found' })

    return res.status(200).json({ page: await buildPublicBookingPage(owner) })
  } catch (err) {
    console.error('[booking-page] GET', err)
    return res.status(500).json({ error: 'Failed to load booking page' })
  }
}
