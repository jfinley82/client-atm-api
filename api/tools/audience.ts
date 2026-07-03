import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import savedHandler from './saved'

// REST alias for the unified tools chat handler. The frontend calls the tool by
// path (/api/tools/audience); we fix tool_type from the path and delegate to the
// same logic as /api/tools/chat (which also runs setCors + OPTIONS handling).
//
// GET: confirmed via prod logs that the frontend calls GET here (alongside
// /api/progress and /api/auth/me on load) to check for an existing saved
// session before starting a new one — delegate to the same saved_outputs
// lookup /api/tools/saved uses.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    req.query = { ...req.query, tool_type: 'audience' }
    return savedHandler(req, res)
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'audience' }
  }
  return chatHandler(req, res)
}
