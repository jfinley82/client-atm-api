import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'

// REST alias for the unified tools chat handler. The frontend calls the tool by
// path (/api/tools/audience); we fix tool_type from the path and delegate to the
// same logic as /api/tools/chat (which also runs setCors + OPTIONS handling).
//
// GET: confirmed via prod logs that the frontend calls GET here (alongside
// /api/progress and /api/auth/me on load) to check for an existing saved
// session before starting a new one. Always returns { output, exists } so
// callers never have to null-check the whole body.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    if (setCors(req, res)) return
    const userId = await requireActiveUser(req, res)
    if (!userId) return
    try {
      const saved = await getSavedOutput(userId, 'audience')
      return res.status(200).json({ output: saved?.content ?? null, exists: !!saved })
    } catch (err) {
      console.error('[tools/audience] GET', err)
      return res.status(500).json({ error: 'Failed to load saved output' })
    }
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'audience' }
  }
  return chatHandler(req, res)
}
