import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getMemberSnapshot } from '../../lib/assistantContext'

// GET /api/assistant/checklist — the follow-along checklist shown in the MTM
// Coach popup. Derived from the same progress the dashboard reads, so it stays
// in sync automatically as the member completes steps. No new tables, no writes.
//
// Returns: { items: [{ key, label, status }], percent }
// status is 'done' | 'current' | 'locked'; exactly one item is 'current' until
// the whole path is done.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { checklist, percent } = await getMemberSnapshot(userId)
    return res.status(200).json({ items: checklist, percent })
  } catch (err) {
    console.error('[assistant/checklist] GET', err)
    return res.status(500).json({ error: 'Failed to load checklist' })
  }
}
