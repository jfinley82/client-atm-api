import type { VercelRequest, VercelResponse } from '@vercel/node'
import { clearSessionCookie } from '../../lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  clearSessionCookie(res as any)
  return res.status(200).json({ ok: true })
}
