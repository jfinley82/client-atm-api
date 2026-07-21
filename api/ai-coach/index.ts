import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'

// GET /api/ai-coach — the coach's stored account-level AI Coach, or null.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  if (!(await requireCapability(userId, 'toolkits', res))) return

  try {
    const saved = await getSavedOutput(userId, 'ai_coach')
    return res.status(200).json(saved?.content ?? null)
  } catch (err) {
    console.error('[ai-coach] GET', err)
    return res.status(500).json({ error: 'Failed to load AI Coach' })
  }
}
