import type { VercelRequest, VercelResponse } from '@vercel/node'
import chatHandler from './chat'

// REST alias for the unified tools chat handler (tool_type fixed from the path).
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    const base = req.body && typeof req.body === 'object' ? req.body : {}
    req.body = { ...base, tool_type: 'transformation' }
  }
  return chatHandler(req, res)
}
