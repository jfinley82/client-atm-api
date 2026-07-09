import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { computeStaleness } from '../../lib/syncDependencies'

// Read-only staleness detector — no tier gate, this does no AI generation.
// Returns which confirmed items were built from upstream data that has since
// changed, and exactly which dependency caused it, so the member can re-sync
// one item at a time via that item's EXISTING analyze/confirm flow. This
// endpoint never regenerates anything itself.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const result = await computeStaleness(userId)
    return res.status(200).json(result)
  } catch (err) {
    console.error('[sync/status] GET', err)
    return res.status(500).json({ error: 'Failed to compute sync status' })
  }
}
