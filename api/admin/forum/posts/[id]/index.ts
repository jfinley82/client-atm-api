import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { requireActiveUser } from '../../../../../lib/auth'
import { setCors } from '../../../../../lib/cors'

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
    // forum_comments.post_id and forum_likes.post_id are ON DELETE CASCADE,
    // so removing the post removes its comments and likes.
    const { data, error } = await supabase
      .from('forum_posts')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Post not found' })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[admin/forum/posts/[id]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete post' })
  }
}
