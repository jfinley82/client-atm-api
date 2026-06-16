import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const postId = req.query.postId as string
  if (!postId) return res.status(400).json({ error: 'postId required' })

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { data: existing } = await supabase
      .from('forum_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle()

    let liked: boolean
    if (existing) {
      await supabase.from('forum_likes').delete().eq('id', existing.id)
      liked = false
    } else {
      await supabase.from('forum_likes').insert({ post_id: postId, user_id: userId })
      liked = true
    }

    const { count } = await supabase
      .from('forum_likes')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId)

    const like_count = count ?? 0

    await supabase
      .from('forum_posts')
      .update({ like_count })
      .eq('id', postId)

    return res.status(200).json({ liked, like_count })
  } catch (err) {
    console.error('[forum/like]', err)
    return res.status(500).json({ error: 'Failed to toggle like' })
  }
}
