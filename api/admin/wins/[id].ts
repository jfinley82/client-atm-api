import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'DELETE') return res.status(405).end()

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

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    // win_likes.win_id is ON DELETE CASCADE, so removing the win removes its likes.
    const { data, error } = await supabase
      .from('wins')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Win not found' })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[admin/wins/[id]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete win' })
  }
}
