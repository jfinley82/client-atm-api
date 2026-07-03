import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getMtmSessionProgress } from '../../lib/progress'

// GET /api/progress — the member dashboard's MTM session progress reader
// (Audience, Transformation, Matcher, Blueprint generation). Shares the exact
// computation used by the admin member-detail view via lib/progress.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const sessions = await getMtmSessionProgress(userId)
    return res.status(200).json({ sessions })
  } catch (err) {
    console.error('[progress] GET', err)
    return res.status(500).json({ error: 'Failed to load progress' })
  }
}
