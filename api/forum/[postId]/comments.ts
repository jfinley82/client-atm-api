import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { buildCommentTree, recomputeCommentCount } from '../../../lib/forum'

// GET returns a TREE, not a flat array: the frontend is built tree-shaped from
// the first line, so the nesting is the server's to produce. POST accepts an
// optional parent_id to reply to a comment rather than to the post.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const postId = req.query.postId as string
  if (!postId) return res.status(400).json({ error: 'postId required' })

  if (req.method === 'GET') {
    try {
      // Oldest first, then nested in one pass, so a reply always follows what
      // it replies to at every level.
      const { data, error } = await supabase
        .from('forum_comments')
        .select(`id, body, created_at, edited_at, parent_id, deleted_at, user:users(id, name)`)
        .eq('post_id', postId)
        .order('created_at', { ascending: true })

      if (error) throw error
      return res.status(200).json({ comments: buildCommentTree((data || []) as any) })
    } catch (err) {
      console.error('[forum/comments] GET', err)
      return res.status(500).json({ error: 'Failed to load comments' })
    }
  }

  if (req.method === 'POST') {
    const userId = await requireActiveUser(req, res)
    if (!userId) return

    const { body, parent_id: rawParentId } = req.body || {}
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body required' })
    }

    const parentId = typeof rawParentId === 'string' && rawParentId.trim() ? rawParentId.trim() : null

    try {
      // The parent must exist AND belong to THIS post. Without the second check
      // a reply could be grafted onto another thread's comment, and the tree
      // builder would then silently render it as top-level here — a comment
      // that appears in a thread it was never written in.
      if (parentId) {
        const { data: parent } = await supabase
          .from('forum_comments')
          .select('id, post_id')
          .eq('id', parentId)
          .maybeSingle()
        if (!parent || (parent as { post_id: string }).post_id !== postId) {
          return res.status(400).json({ error: 'parent_not_in_thread' })
        }
      }

      const { data, error } = await supabase
        .from('forum_comments')
        .insert({
          post_id: postId,
          user_id: userId,
          body: body.trim(),
          parent_id: parentId,
        })
        .select(`id, body, created_at, edited_at, parent_id, user:users(id, name)`)
        .single()

      if (error) throw error

      // Recompute from the source of truth — shared so every mutating path
      // counts the same way. See lib/forum.
      await recomputeCommentCount(postId)

      return res.status(200).json({ comment: data })
    } catch (err) {
      console.error('[forum/comments] POST', err)
      return res.status(500).json({ error: 'Failed to create comment' })
    }
  }

  return res.status(405).end()
}
