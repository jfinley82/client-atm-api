import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

// Fields an admin is allowed to update on a training video
const UPDATABLE_FIELDS = [
  'title',
  'description',
  'video_url',
  'thumbnail_url',
  'duration_minutes',
  'is_published',
  'published_at',
] as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

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

  if (req.method === 'PATCH') {
    const body = req.body || {}
    const updates: Record<string, unknown> = {}
    for (const field of UPDATABLE_FIELDS) {
      if (field in body) updates[field] = body[field]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' })
    }

    try {
      const { data, error } = await supabase
        .from('training_videos')
        .update(updates)
        .eq('id', id)
        .select('*')
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Training video not found' })

      return res.status(200).json({ video: data })
    } catch (err) {
      console.error('[admin/training/[id]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update training video' })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { data, error } = await supabase
        .from('training_videos')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Training video not found' })

      return res.status(200).json({ success: true })
    } catch (err) {
      console.error('[admin/training/[id]] DELETE', err)
      return res.status(500).json({ error: 'Failed to delete training video' })
    }
  }

  return res.status(405).end()
}
