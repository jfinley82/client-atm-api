import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../lib/supabase'
import { requireActiveUser } from '../lib/auth'
import { setCors } from '../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { data, error } = await supabase
      .from('training_videos')
      .select('id, title, description, video_url, thumbnail_url, duration_minutes, published_at')
      .eq('is_published', true)
      .order('published_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({ videos: data || [] })
  } catch (err) {
    console.error('[training] GET', err)
    return res.status(500).json({ error: 'Failed to load training videos' })
  }
}
