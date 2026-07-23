import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireAdmin } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import {
  isValidCategory,
  suggestedTitle,
  suggestedCoachName,
  publicUrlForSubdomain,
  TITLE_MAX,
  HOOK_MAX,
  COACH_NAME_MAX,
} from '../../../lib/hub'

// GET  /api/hub/admin/listings — all listings (draft + published) with the
//   funnel's current status + resolved live URL.
// POST /api/hub/admin/listings — create a draft listing for a live funnel that
//   has none yet.
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null
}

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

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('hub_listings')
        .select('*, funnels(subdomain, status)')
        .order('featured', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false })
      if (error) throw error

      const listings = ((data || []) as Record<string, any>[]).map((row) => {
        const funnel = one<{ subdomain?: string | null; status?: string | null }>(row.funnels)
        const { funnels, ...listing } = row
        return {
          ...listing,
          funnel_status: funnel?.status ?? null,
          funnel_live: funnel?.status === 'live',
          target_url: funnel?.subdomain ? publicUrlForSubdomain(funnel.subdomain) : null,
        }
      })
      return res.status(200).json({ listings })
    } catch (err) {
      console.error('[hub/admin/listings] GET', err)
      return res.status(500).json({ error: 'Failed to load listings' })
    }
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''
    if (!funnelId) return res.status(400).json({ error: 'funnel_id required' })
    if (!isValidCategory(body.category)) return res.status(400).json({ error: 'invalid_category' })
    const category = (body.category as string).trim().toLowerCase()

    try {
      // Require a live funnel with no existing listing.
      const { data: funnel } = await supabase
        .from('funnels')
        .select('id, user_id, subdomain, status, landing_page, problem_solution_label')
        .eq('id', funnelId)
        .maybeSingle()
      if (!funnel || funnel.status !== 'live') return res.status(400).json({ error: 'funnel_not_live' })

      const { data: existing } = await supabase.from('hub_listings').select('id').eq('funnel_id', funnelId).maybeSingle()
      if (existing) return res.status(409).json({ error: 'listing_exists' })

      // Seed title / coach_name from the funnel when omitted.
      let title = suggestedTitle(funnel)
      if (body.title !== undefined) {
        const t = boundedText(body.title, TITLE_MAX)
        if (!t.ok) return res.status(400).json({ error: 'invalid_title' })
        title = t.value
      }

      const [bizRes, userRes] = await Promise.all([
        supabase.from('funnel_business_settings').select('business_name').eq('user_id', funnel.user_id).maybeSingle(),
        supabase.from('users').select('name').eq('id', funnel.user_id).maybeSingle(),
      ])
      let coachName = suggestedCoachName((bizRes.data as { business_name?: string } | null)?.business_name, (userRes.data as { name?: string } | null)?.name)
      if (body.coach_name !== undefined) {
        const c = boundedText(body.coach_name, COACH_NAME_MAX)
        if (!c.ok) return res.status(400).json({ error: 'invalid_coach_name' })
        coachName = c.value
      }

      let hook: string | null = null
      if (body.hook !== undefined && body.hook !== null && body.hook !== '') {
        const h = boundedText(body.hook, HOOK_MAX)
        if (!h.ok) return res.status(400).json({ error: 'invalid_hook' })
        hook = h.value
      }

      const featured = body.featured === true
      const sortOrder = typeof body.sort_order === 'number' && Number.isFinite(body.sort_order) ? Math.trunc(body.sort_order) : 0

      const { data: created, error: insErr } = await supabase
        .from('hub_listings')
        .insert({ funnel_id: funnelId, title, hook, coach_name: coachName, category, featured, sort_order: sortOrder, status: 'draft' })
        .select('*')
        .single()
      if (insErr) {
        // Unique index backstop against a race on the duplicate check.
        if ((insErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'listing_exists' })
        throw insErr
      }

      return res.status(200).json({ listing: created })
    } catch (err) {
      console.error('[hub/admin/listings] POST', err)
      return res.status(500).json({ error: 'Failed to create listing' })
    }
  }

  return res.status(405).end()
}
