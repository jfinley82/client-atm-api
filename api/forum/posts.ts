import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('forum_posts')
        .select(`
          id, title, body, like_count, comment_count, is_pinned, created_at, updated_at,
          user:users(id, name),
          category:forum_categories(id, name, slug)
        `)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw error
      return res.status(200).json({ posts: data || [] })
    } catch (err) {
      console.error('[forum/posts] GET', err)
      return res.status(500).json({ error: 'Failed to load posts' })
    }
  }

  if (req.method === 'POST') {
    const userId = await requireActiveUser(req, res)
    if (!userId) return

    const { title, body, category_id } = req.body || {}
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title required' })
    }
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body required' })
    }

    try {
      const { data, error } = await supabase
        .from('forum_posts')
        .insert({
          user_id: userId,
          category_id: category_id || null,
          title: title.trim(),
          body: body.trim()
        })
        .select(`
          id, title, body, like_count, comment_count, is_pinned, created_at, updated_at,
          user:users(id, name),
          category:forum_categories(id, name, slug)
        `)
        .single()

      if (error) throw error
      return res.status(200).json({ post: data })
    } catch (err) {
      console.error('[forum/posts] POST', err)
      return res.status(500).json({ error: 'Failed to create post' })
    }
  }

  return res.status(405).end()
}
