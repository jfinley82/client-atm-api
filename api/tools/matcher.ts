import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'

// REST alias for the unified tools chat handler (tool_type fixed from the path).
// matcher is now a short existing-offer intake (has_existing_offer, price,
// format, delivery) — the top-10 problem analysis lives under /api/matcher/*.
//
// GET: mirrors /api/tools/audience — load the existing saved intake before
// starting a new one. Reads 'matcher_intake', not 'matcher' (that key is
// retired — see lib/savedOutputs / api/tools/chat.ts). Always returns
// { output, exists } so callers never have to null-check the whole body.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    if (setCors(req, res)) return
    const userId = await requireActiveUser(req, res)
    if (!userId) return
    try {
      const saved = await getSavedOutput(userId, 'matcher_intake')
      return res.status(200).json({ output: saved?.content ?? null, exists: !!saved })
    } catch (err) {
      console.error('[tools/matcher] GET', err)
      return res.status(500).json({ error: 'Failed to load saved output' })
    }
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'matcher' }
  }
  return chatHandler(req, res)
}
