import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'
import savedHandler from './saved'

// REST alias for the unified tools chat handler (tool_type fixed from the path).
//
// GET: mirrors /api/tools/audience — load the existing saved session for this
// tool before starting a new one (see saved_outputs lookup in ./saved).
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    req.query = { ...req.query, tool_type: 'transformation' }
    return savedHandler(req, res)
  }
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'transformation' }
  }
  return chatHandler(req, res)
}
