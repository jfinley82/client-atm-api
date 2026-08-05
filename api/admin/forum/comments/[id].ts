import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors } from '../../../../lib/cors'
import { deleteCommentCascadeAware } from '../../../../lib/forum'

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
    // Same function the member path uses, so moderation and self-delete cannot
    // behave differently: a comment with replies is TOMBSTONED rather than
    // hard-deleted, because parent_id cascades recursively and a plain delete
    // here would take other members' replies with it. The comment_count
    // recompute happens inside, after the delete, so it counts survivors.
    const result = await deleteCommentCascadeAware(id)
    if (!result) return res.status(404).json({ error: 'Comment not found' })

    return res.status(200).json({ success: true, tombstoned: result.tombstoned })
  } catch (err) {
    console.error('[admin/forum/comments/[id]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete comment' })
  }
}
