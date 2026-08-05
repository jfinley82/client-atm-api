import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { authorizeOwnerOrAdmin, deleteCommentCascadeAware } from '../../../lib/forum'

// PATCH /api/forum/comments/[id] — the author edits their own comment.
// DELETE /api/forum/comments/[id] — the author removes it.
//
// DELETE tombstones rather than cascades when the comment has replies: see
// deleteCommentCascadeAware. The recompute runs inside it, AFTER the delete, so
// it counts what actually survived rather than what was expected to.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const authz = await authorizeOwnerOrAdmin('forum_comments', id, userId)
  if (!authz.ok) return res.status(authz.status).json({ error: authz.error })

  try {
    if (req.method === 'DELETE') {
      const result = await deleteCommentCascadeAware(id)
      if (!result) return res.status(404).json({ error: 'not_found' })
      // tombstoned tells the frontend whether the node stays in the tree as a
      // removed placeholder or disappears entirely, so it does not have to
      // guess from a refetch.
      return res.status(200).json({ success: true, tombstoned: result.tombstoned })
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const next = typeof body.body === 'string' ? body.body.trim() : ''
    if (!next) return res.status(400).json({ error: 'body required' })

    // Editing a tombstone would resurrect a comment its author already removed.
    const { data: existing } = await supabase
      .from('forum_comments')
      .select('deleted_at')
      .eq('id', id)
      .maybeSingle()
    if (existing && (existing as { deleted_at: string | null }).deleted_at) {
      return res.status(409).json({ error: 'comment_deleted' })
    }

    const { data, error } = await supabase
      .from('forum_comments')
      .update({ body: next, edited_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, body, created_at, edited_at, parent_id')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'not_found' })

    return res.status(200).json({ comment: data })
  } catch (err) {
    console.error('[forum/comments/[id]]', req.method, err)
    return res.status(500).json({ error: 'Failed to update comment' })
  }
}
