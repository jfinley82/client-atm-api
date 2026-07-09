import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getThreadList, getThreadMessages } from '../../lib/assistantHistory'

// GET /api/assistant/threads — the MTM Coach widget's "Past chats" list.
// GET /api/assistant/threads?threadId=<uuid> — one past thread's full
// transcript, read-only. Both scoped to the requesting member; a threadId
// belonging to someone else returns an empty result, never another
// member's messages.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : null
    if (threadId) {
      const messages = await getThreadMessages(userId, threadId)
      return res.status(200).json({ messages })
    }
    const threads = await getThreadList(userId)
    return res.status(200).json({ threads })
  } catch (err) {
    console.error('[assistant/threads] GET', err)
    return res.status(500).json({ error: 'Failed to load past conversations' })
  }
}
