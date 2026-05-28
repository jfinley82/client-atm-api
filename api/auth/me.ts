import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase.js'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ user: null })

  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ user: null })

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, name, has_paid, quiz_completed, quiz_score, created_at')
    .eq('id', payload.userId)
    .single()

  if (error || !user) return res.status(401).json({ user: null })

  return res.status(200).json({ user })
}
