import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory, extractSessionHistory } from '../../lib/savedOutputs'

// REST alias for the unified tools chat handler (tool_type fixed from the path).
//
// GET: mirrors /api/tools/audience — load the existing saved session for this
// tool before starting a new one. Returns { output, session_history, exists };
// session_history rehydrates an in-progress conversation on reload.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    if (setCors(req, res)) return
    const userId = await requireActiveUser(req, res)
    if (!userId) return
    try {
      const saved = await getSavedOutput(userId, 'transformation')
      return res.status(200).json({
        output: stripSessionHistory(saved?.content) ?? null,
        session_history: extractSessionHistory(saved?.content),
        exists: !!saved,
      })
    } catch (err) {
      console.error('[tools/transformation] GET', err)
      return res.status(500).json({ error: 'Failed to load saved output' })
    }
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'transformation' }
  }
  return chatHandler(req, res)
}
