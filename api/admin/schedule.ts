import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', payload.userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('unlock_schedule')
        .select('*')
        .order('item_key', { ascending: true })

      if (error) throw error
      return res.status(200).json({ schedule: data || [] })
    } catch (err) {
      console.error('[admin/schedule] GET', err)
      return res.status(500).json({ error: 'Failed to load schedule' })
    }
  }

  if (req.method === 'POST') {
    const { item_key, unlock_at } = req.body || {}

    if (!item_key || typeof item_key !== 'string') {
      return res.status(400).json({ error: 'item_key required' })
    }
    if (unlock_at !== null && typeof unlock_at !== 'string') {
      return res.status(400).json({ error: 'unlock_at must be an ISO string or null' })
    }

    try {
      const { data, error } = await supabase
        .from('unlock_schedule')
        .update({ unlock_at, updated_at: new Date().toISOString() })
        .eq('item_key', item_key)
        .select()
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Unknown item_key' })

      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[admin/schedule] POST', err)
      return res.status(500).json({ error: 'Failed to update schedule' })
    }
  }

  return res.status(405).end()
}
