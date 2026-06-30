import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const WIN_TYPES = ['general', 'client', 'revenue', 'milestone', 'booking']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method === 'GET') {
    const userId = await requireActiveUser(req, res)
    if (!userId) return

    try {
      const { data, error } = await supabase
        .from('wins')
        .select(`
          id, content, win_type, likes_count, created_at,
          user:users(id, name)
        `)
        .order('created_at', { ascending: false })

      if (error) throw error
      return res.status(200).json({ wins: data || [] })
    } catch (err) {
      console.error('[wins] GET', err)
      return res.status(500).json({ error: 'Failed to load wins' })
    }
  }

  if (req.method === 'POST') {
    const userId = await requireActiveUser(req, res)
    if (!userId) return

    const { content, win_type } = req.body || {}
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content required' })
    }
    if (win_type !== undefined && !WIN_TYPES.includes(win_type)) {
      return res.status(400).json({ error: `win_type must be one of: ${WIN_TYPES.join(', ')}` })
    }

    try {
      const { data, error } = await supabase
        .from('wins')
        .insert({
          user_id: userId,
          content: content.trim(),
          win_type: win_type || 'general',
        })
        .select(`
          id, content, win_type, likes_count, created_at,
          user:users(id, name)
        `)
        .single()

      if (error) throw error
      return res.status(200).json({ win: data })
    } catch (err) {
      console.error('[wins] POST', err)
      return res.status(500).json({ error: 'Failed to create win' })
    }
  }

  return res.status(405).end()
}
