import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const winId = req.query.id as string
  if (!winId) return res.status(400).json({ error: 'id required' })

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { data: existing } = await supabase
      .from('win_likes')
      .select('id')
      .eq('win_id', winId)
      .eq('user_id', userId)
      .maybeSingle()

    let liked: boolean
    if (existing) {
      await supabase.from('win_likes').delete().eq('id', existing.id)
      liked = false
    } else {
      await supabase.from('win_likes').insert({ win_id: winId, user_id: userId })
      liked = true
    }

    const { count } = await supabase
      .from('win_likes')
      .select('id', { count: 'exact', head: true })
      .eq('win_id', winId)

    const likes_count = count ?? 0

    await supabase
      .from('wins')
      .update({ likes_count })
      .eq('id', winId)

    return res.status(200).json({ liked, likes_count })
  } catch (err) {
    console.error('[wins/like]', err)
    return res.status(500).json({ error: 'Failed to toggle like' })
  }
}
