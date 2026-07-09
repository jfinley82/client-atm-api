import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { archiveActiveHistory } from '../../lib/assistantHistory'

// POST /api/assistant/restart — the widget's "Restart chat" control calls
// this. Archives the member's active conversation (archived_at set, rows
// kept) so their next message starts a clean thread with no prior turns in
// context. Nothing about their app progress or saved_outputs is touched.
//
// Returns: { ok: true }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    await archiveActiveHistory(userId)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[assistant/restart] POST', err)
    return res.status(500).json({ error: 'Failed to restart the conversation' })
  }
}
