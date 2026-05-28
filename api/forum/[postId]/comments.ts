import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const postId = req.query.postId as string
  if (!postId) return res.status(400).json({ error: 'postId required' })

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('forum_comments')
        .select(`id, body, created_at, user:users(id, name)`)
        .eq('post_id', postId)
        .order('created_at', { ascending: true })

      if (error) throw error
      return res.status(200).json({ comments: data || [] })
    } catch (err) {
      console.error('[forum/comments] GET', err)
      return res.status(500).json({ error: 'Failed to load comments' })
    }
  }

  if (req.method === 'POST') {
    const sessionToken = getSessionFromRequest(req as any)
    if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
    const payload = await verifySessionToken(sessionToken)
    if (!payload) return res.status(401).json({ error: 'Unauthorized' })

    const { body } = req.body || {}
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body required' })
    }

    try {
      const { data, error } = await supabase
        .from('forum_comments')
        .insert({
          post_id: postId,
          user_id: payload.userId,
          body: body.trim()
        })
        .select(`id, body, created_at, user:users(id, name)`)
        .single()

      if (error) throw error

      // Recompute comment_count from the source of truth
      const { count } = await supabase
        .from('forum_comments')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId)

      await supabase
        .from('forum_posts')
        .update({ comment_count: count ?? 0, updated_at: new Date().toISOString() })
        .eq('id', postId)

      return res.status(200).json({ comment: data })
    } catch (err) {
      console.error('[forum/comments] POST', err)
      return res.status(500).json({ error: 'Failed to create comment' })
    }
  }

  return res.status(405).end()
}
