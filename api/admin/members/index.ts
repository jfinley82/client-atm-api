import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const rawTier = req.query.tier
  const rawStatus = req.query.status
  const tier = Array.isArray(rawTier) ? rawTier[0] : rawTier
  const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus

  try {
    let query = supabase
      .from('users')
      .select('id, name, email, membership_tier, status, created_at')
      .order('created_at', { ascending: false })

    if (tier) query = query.eq('membership_tier', tier)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    return res.status(200).json({ members: data || [] })
  } catch (err) {
    console.error('[admin/members] GET', err)
    return res.status(500).json({ error: 'Failed to load members' })
  }
}
