import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'

// GET /api/forum/categories — the forum's category list, in display order.
//
// Unauthenticated, matching the GET half of api/forum/posts.ts: the feed
// loads for everyone, so the categories that label and filter it have to load
// for everyone too. There is nothing user-scoped in a category row.
//
// Queried live rather than hardcoded anywhere, so adding a row is a data
// change (see migration 081) and never a code change.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  try {
    const { data, error } = await supabase
      .from('forum_categories')
      .select('id, name, slug, description, sort_order')
      // sort_order is the intended display order, but it is nullable with a
      // default of 0 — so anything seeded without one ties. name breaks the
      // tie, keeping the list stable across requests instead of letting
      // Postgres return tied rows in whatever order it likes.
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) throw error

    return res.status(200).json({ categories: data || [] })
  } catch (err) {
    console.error('[forum/categories] GET', err)
    return res.status(500).json({ error: 'Failed to load categories' })
  }
}
