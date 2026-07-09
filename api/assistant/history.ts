import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getActiveHistory } from '../../lib/assistantHistory'

// GET /api/assistant/history — the MTM Coach widget calls this on open to
// restore the member's conversation instead of starting blank every time
// the page reloads. Returns whatever is currently active (not archived by
// a prior "restart").
//
// Returns: { messages: [{ role: 'user' | 'assistant', content: string }] }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const messages = await getActiveHistory(userId)
    return res.status(200).json({ messages })
  } catch (err) {
    console.error('[assistant/history] GET', err)
    return res.status(500).json({ error: 'Failed to load conversation history' })
  }
}
