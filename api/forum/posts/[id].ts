import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { authorizeOwnerOrAdmin } from '../../../lib/forum'

// PATCH /api/forum/posts/[id] — the author edits their own post.
// DELETE /api/forum/posts/[id] — the author removes it.
//
// Both are author-OR-admin. Until now only admins could remove anything, so a
// member could not fix their own typo. The admin-only endpoints under
// api/admin/forum stay as they are; this is the member's own door, sharing one
// authorization function with them so the two cannot drift.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const authz = await authorizeOwnerOrAdmin('forum_posts', id, userId)
  if (!authz.ok) return res.status(authz.status).json({ error: authz.error })

  try {
    if (req.method === 'DELETE') {
      // forum_comments.post_id and forum_likes.post_id are ON DELETE CASCADE,
      // so the comments and likes go with it. That cascade is correct HERE —
      // deleting the thread is meant to take the thread — unlike deleting a
      // single comment, where it would take other members' replies.
      const { error } = await supabase.from('forum_posts').delete().eq('id', id)
      if (error) throw error
      return res.status(200).json({ success: true })
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const update: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) update.title = body.title.trim()
    if (typeof body.body === 'string' && body.body.trim()) update.body = body.body.trim()
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'nothing_to_update' })
    }

    // edited_at, NOT updated_at. updated_at already means "last activity on
    // this thread" — the comment_count recompute writes it on every new
    // comment — so using it here would mark a post as edited the moment
    // somebody replied to it.
    update.edited_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('forum_posts')
      .update(update)
      .eq('id', id)
      .select('id, title, body, created_at, updated_at, edited_at')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'not_found' })

    return res.status(200).json({ post: data })
  } catch (err) {
    console.error('[forum/posts/[id]]', req.method, err)
    return res.status(500).json({ error: 'Failed to update post' })
  }
}
