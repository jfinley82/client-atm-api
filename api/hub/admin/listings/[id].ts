import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireAdmin } from '../../../../lib/auth'
import { setCors, noStore } from '../../../../lib/cors'
import { isValidCategory, TITLE_MAX, HOOK_MAX, COACH_NAME_MAX } from '../../../../lib/hub'

// PATCH  /api/hub/admin/listings/[id] — update editable fields.
// DELETE /api/hub/admin/listings/[id] — remove the listing + its cover object.
const EDITABLE = new Set(['title', 'hook', 'coach_name', 'category', 'featured', 'sort_order', 'status'])

function boundedText(v: unknown, max: number): { ok: true; value: string } | { ok: false } {
  if (typeof v !== 'string') return { ok: false }
  const t = v.trim()
  if (!t || t.length > max) return { ok: false }
  return { ok: true, value: t }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const userId = await requireAdmin(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase.from('hub_listings').delete().eq('id', id)
      if (error) throw error
      // Best-effort remove the cover object (path is the listing id).
      await supabase.storage.from('hub-covers').remove([`hub-covers/${id}`]).catch(() => {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[hub/admin/listings/[id]] DELETE', err)
      return res.status(500).json({ error: 'Failed to delete listing' })
    }
  }

  if (req.method !== 'PATCH') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (!EDITABLE.has(key)) return res.status(400).json({ error: 'unknown_field', field: key })
  }

  const update: Record<string, unknown> = {}

  if ('title' in body) {
    const t = boundedText(body.title, TITLE_MAX)
    if (!t.ok) return res.status(400).json({ error: 'invalid_title' })
    update.title = t.value
  }
  if ('coach_name' in body) {
    const c = boundedText(body.coach_name, COACH_NAME_MAX)
    if (!c.ok) return res.status(400).json({ error: 'invalid_coach_name' })
    update.coach_name = c.value
  }
  if ('hook' in body) {
    if (body.hook === null || body.hook === '') {
      update.hook = null
    } else {
      const h = boundedText(body.hook, HOOK_MAX)
      if (!h.ok) return res.status(400).json({ error: 'invalid_hook' })
      update.hook = h.value
    }
  }
  if ('category' in body) {
    if (!isValidCategory(body.category)) return res.status(400).json({ error: 'invalid_category' })
    update.category = (body.category as string).trim().toLowerCase()
  }
  if ('featured' in body) {
    if (typeof body.featured !== 'boolean') return res.status(400).json({ error: 'invalid_featured' })
    update.featured = body.featured
  }
  if ('sort_order' in body) {
    if (typeof body.sort_order !== 'number' || !Number.isFinite(body.sort_order)) return res.status(400).json({ error: 'invalid_sort_order' })
    update.sort_order = Math.trunc(body.sort_order)
  }
  if ('status' in body) {
    if (body.status !== 'draft' && body.status !== 'published') return res.status(400).json({ error: 'invalid_status' })
    update.status = body.status
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No updatable fields provided' })
  update.updated_at = new Date().toISOString()

  try {
    const { data, error } = await supabase.from('hub_listings').update(update).eq('id', id).select('*').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Listing not found' })
    return res.status(200).json({ listing: data })
  } catch (err) {
    console.error('[hub/admin/listings/[id]] PATCH', err)
    return res.status(500).json({ error: 'Failed to update listing' })
  }
}
