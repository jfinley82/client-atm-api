import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'

// REST alias for the unified tools chat handler. The frontend calls the tool by
// path (/api/tools/audience); we fix tool_type from the path and delegate to the
// same logic as /api/tools/chat (which also runs setCors + OPTIONS handling).
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'audience' }
  }
  return chatHandler(req, res)
}
