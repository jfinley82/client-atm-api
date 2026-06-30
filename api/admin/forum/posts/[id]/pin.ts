import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { requireActiveUser } from '../../../../../lib/auth'
import { setCors } from '../../../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()

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
    const { data: post, error: fetchError } = await supabase
      .from('forum_posts')
      .select('is_pinned')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) throw fetchError
    if (!post) return res.status(404).json({ error: 'Post not found' })

    const is_pinned = !post.is_pinned
    const pinned_at = is_pinned ? new Date().toISOString() : null

    const { data, error } = await supabase
      .from('forum_posts')
      .update({ is_pinned, pinned_at })
      .eq('id', id)
      .select('id, is_pinned, pinned_at')
      .single()

    if (error) throw error

    return res.status(200).json(data)
  } catch (err) {
    console.error('[admin/forum/posts/[id]/pin] PATCH', err)
    return res.status(500).json({ error: 'Failed to toggle pin' })
  }
}
