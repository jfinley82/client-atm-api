import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { loadPublishedListings } from '../../lib/hub'

// GET /api/hub/listings — PUBLIC card feed for the Training Hub. Rate-limited,
// cacheable (the catalog changes rarely and every card is already public).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  if (!rateLimit(`hub_listings:${clientIp(req)}`, 60, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  try {
    const listings = await loadPublishedListings()
    res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=15, stale-while-revalidate=60')
    return res.status(200).json({ listings })
  } catch (err) {
    console.error('[hub/listings] GET', err)
    return res.status(500).json({ error: 'Failed to load listings' })
  }
}
