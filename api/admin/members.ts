import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

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

  try {
    // Never select password_hash
    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, profession, has_paid, quiz_completed, video_watched, role, created_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({ members: data || [] })
  } catch (err) {
    console.error('[admin/members]', err)
    return res.status(500).json({ error: 'Failed to load members' })
  }
}
