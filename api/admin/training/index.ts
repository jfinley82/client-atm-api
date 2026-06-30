import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

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

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('training_videos')
        .select('*')
        .order('published_at', { ascending: false })

      if (error) throw error
      return res.status(200).json({ videos: data || [] })
    } catch (err) {
      console.error('[admin/training] GET', err)
      return res.status(500).json({ error: 'Failed to load training videos' })
    }
  }

  if (req.method === 'POST') {
    const { title, description, video_url, thumbnail_url, duration_minutes } = req.body || {}

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title required' })
    }
    if (!video_url || typeof video_url !== 'string') {
      return res.status(400).json({ error: 'video_url required' })
    }

    try {
      const { data, error } = await supabase
        .from('training_videos')
        .insert({
          title,
          description: description ?? null,
          video_url,
          thumbnail_url: thumbnail_url ?? null,
          duration_minutes: duration_minutes ?? null,
        })
        .select('*')
        .single()

      if (error) throw error
      return res.status(200).json({ video: data })
    } catch (err) {
      console.error('[admin/training] POST', err)
      return res.status(500).json({ error: 'Failed to create training video' })
    }
  }

  return res.status(405).end()
}
