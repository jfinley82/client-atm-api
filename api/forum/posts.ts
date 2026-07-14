import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser, getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method === 'GET') {
    try {
      // Reads stay unauthenticated (the feed loads for everyone) — this only
      // decodes a session if one is present, it never rejects the request
      // for lacking one. Same decode-without-enforcing pattern as
      // api/auth/me.ts, deliberately not requireActiveUser (which would
      // force auth and change this endpoint's access model).
      const sessionToken = getSessionFromRequest(req)
      let userId: string | null = null
      if (sessionToken) {
        const payload = await verifySessionToken(sessionToken)
        if (payload) userId = payload.userId
      }

      const postsPromise = supabase
        .from('forum_posts')
        .select(`
          id, title, body, like_count, comment_count, is_pinned, pinned_at, created_at, updated_at,
          user:users(id, name),
          category:forum_categories(id, name, slug)
        `)
        .order('is_pinned', { ascending: false })
        .order('pinned_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(50)

      // Only queried when a valid user is present — an anonymous read has
      // nothing to look up and every post's user_has_liked defaults to false.
      const likesPromise = userId
        ? supabase.from('forum_likes').select('post_id').eq('user_id', userId)
        : Promise.resolve({ data: [] as { post_id: string }[], error: null as null })

      const [{ data, error }, { data: likedRows, error: likesError }] = await Promise.all([postsPromise, likesPromise])

      if (error) throw error
      if (likesError) throw likesError

      // Mirrors how user_has_rsvpd is computed for events (GET /api/events):
      // a per-row existence check against the join table, keyed into a Set
      // for O(1) lookup per post.
      const likedIds = new Set((likedRows || []).map((r) => r.post_id as string))
      const posts = (data || []).map((p) => ({ ...p, user_has_liked: likedIds.has(p.id) }))

      return res.status(200).json({ posts })
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
          id, title, body, like_count, comment_count, is_pinned, pinned_at, created_at, updated_at,
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
