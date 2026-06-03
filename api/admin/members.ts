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

  // GET — list members, optionally filtered by a search term
  if (req.method === 'GET') {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const limit = Math.min(Number(req.query.limit) || 100, 500)

    try {
      let query = supabase
        .from('users')
        .select('id, email, name, business_name, has_paid, role, quiz_completed, quiz_score, video_watched, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (search) {
        query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
      }

      const { data, error } = await query
      if (error) throw error

      return res.status(200).json({ members: data || [] })
    } catch (err) {
      console.error('[admin/members] GET', err)
      return res.status(500).json({ error: 'Failed to load members' })
    }
  }

  // POST — update a member's access flags (has_paid / role)
  if (req.method === 'POST') {
    const { user_id, has_paid, role } = req.body || {}

    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id required' })
    }

    const updates: Record<string, boolean | string> = {}

    if (has_paid !== undefined) {
      if (typeof has_paid !== 'boolean') {
        return res.status(400).json({ error: 'has_paid must be a boolean' })
      }
      updates.has_paid = has_paid
    }

    if (role !== undefined) {
      if (role !== 'user' && role !== 'admin') {
        return res.status(400).json({ error: "role must be 'user' or 'admin'" })
      }
      updates.role = role
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' })
    }

    try {
      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', user_id)
        .select('id, email, name, has_paid, role')
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Member not found' })

      return res.status(200).json({ ok: true, member: data })
    } catch (err) {
      console.error('[admin/members] POST', err)
      return res.status(500).json({ error: 'Failed to update member' })
    }
  }

  return res.status(405).end()
}
