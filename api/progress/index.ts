import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getMtmSessionProgress, getMtmJourney } from '../../lib/progress'

// GET /api/progress — the member dashboard's MTM progress reader. Returns two
// views computed server-side: `sessions` (the finer-grained session checklist,
// shared with the admin member-detail view) and `journey` (the authoritative
// five-step UI journey — Attract, Transform, Monetize, Build, Launch — so the
// frontend stops re-deriving step completion).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const [sessions, journey] = await Promise.all([getMtmSessionProgress(userId), getMtmJourney(userId)])
    return res.status(200).json({ sessions, journey })
  } catch (err) {
    console.error('[progress] GET', err)
    return res.status(500).json({ error: 'Failed to load progress' })
  }
}
