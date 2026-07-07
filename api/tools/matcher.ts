import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory, extractSessionHistory, resetToolOutputs } from '../../lib/savedOutputs'

// REST alias for the unified tools chat handler (tool_type fixed from the path).
// matcher is now a short existing-offer intake (has_existing_offer, price,
// format, delivery) — the top-10 problem analysis lives under /api/matcher/*.
//
// GET: mirrors /api/tools/audience — load the existing saved intake before
// starting a new one. Reads 'matcher_intake', not 'matcher' (that key is
// retired — see lib/savedOutputs / api/tools/chat.ts). Returns
// { output, session_history, exists }; session_history rehydrates the intake
// conversation on reload.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    if (setCors(req, res)) return
    const userId = await requireActiveUser(req, res)
    if (!userId) return
    try {
      const saved = await getSavedOutput(userId, 'matcher_intake')
      return res.status(200).json({
        output: stripSessionHistory(saved?.content) ?? null,
        session_history: extractSessionHistory(saved?.content),
        exists: !!saved,
      })
    } catch (err) {
      console.error('[tools/matcher] GET', err)
      return res.status(500).json({ error: 'Failed to load saved output' })
    }
  }
  if (req.method === 'DELETE') {
    // "Restart Chat" — clear the matcher intake + its derived analysis so a new
    // intake starts fresh. Keeps problem_solution_cards (the finalized Monetize
    // output); restarting the intake leaves those out of sync, a frontend warn.
    if (setCors(req, res)) return
    const userId = await requireActiveUser(req, res)
    if (!userId) return
    try {
      const cleared = await resetToolOutputs(userId, 'matcher')
      return res.status(200).json({ reset: true, cleared })
    } catch (err) {
      console.error('[tools/matcher] DELETE', err)
      return res.status(500).json({ error: 'Failed to reset' })
    }
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'matcher' }
  }
  return chatHandler(req, res)
}
