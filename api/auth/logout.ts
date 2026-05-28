import type { VercelRequest, VercelResponse } from '@vercel/node'
import { clearSessionCookie } from '../../lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') return res.status(204).end()

  clearSessionCookie(res as any)
  return res.status(200).json({ ok: true })
}
