import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { buildPublicBookingPage, resolveBookingSlug } from '../../lib/bookingPage'

// GET /api/booking-page?slug=… — PUBLIC. Everything the coach's own booking
// page renders, in one call rather than three.
//
// Rate-limited like api/funnel/availability.ts: this is an unauthenticated
// endpoint that reads the database on every hit and takes an attacker-supplied
// key, so it is also a slug-enumeration surface.
//
// 404 on an unknown slug, and 404 on a slug that resolves to a coach who has not
// configured anything. Never distinguish "exists but unconfigured" from "does
// not exist" — the difference is only useful to someone probing for which slugs
// are taken.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const ip = clientIp(req)
  if (!rateLimit(`booking_page:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const raw = req.query?.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  if (!slug) return res.status(400).json({ error: 'slug required' })

  try {
    const owner = await resolveBookingSlug(slug)
    // An invalid slug and an unclaimed one answer identically: a malformed slug
    // is not a different fact about the world, it is just not a page.
    if (!owner) return res.status(404).json({ error: 'not_found' })

    return res.status(200).json({ page: await buildPublicBookingPage(owner) })
  } catch (err) {
    console.error('[booking-page] GET', err)
    return res.status(500).json({ error: 'Failed to load booking page' })
  }
}
