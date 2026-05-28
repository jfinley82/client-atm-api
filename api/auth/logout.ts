import type { VercelRequest, VercelResponse } from '@vercel/node'
import { clearSessionCookie } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  clearSessionCookie(res as any)
  return res.status(200).json({ ok: true })
}
