import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireAdmin } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { suggestedTitle, suggestedCoachName } from '../../../lib/hub'

// GET /api/hub/admin/eligible-funnels — live funnels that have no hub listing
// yet, with a suggested title + coach name for the create form.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireAdmin(req, res)
  if (!userId) return

  try {
    const [listedRes, funnelsRes] = await Promise.all([
      supabase.from('hub_listings').select('funnel_id'),
      supabase.from('funnels').select('id, subdomain, user_id, landing_page, problem_solution_label').eq('status', 'live'),
    ])
    const listed = new Set((listedRes.data || []).map((r) => (r as { funnel_id: string }).funnel_id))
    const eligible = ((funnelsRes.data || []) as Record<string, any>[]).filter((f) => f.subdomain && !listed.has(f.id))

    // Batch the coach-name sources.
    const userIds = [...new Set(eligible.map((f) => f.user_id).filter(Boolean))]
    const [bizRes, usersRes] = await Promise.all([
      userIds.length ? supabase.from('funnel_business_settings').select('user_id, business_name').in('user_id', userIds) : Promise.resolve({ data: [] }),
      userIds.length ? supabase.from('users').select('id, name').in('id', userIds) : Promise.resolve({ data: [] }),
    ])
    const bizMap = new Map(((bizRes.data || []) as Record<string, any>[]).map((b) => [b.user_id, b.business_name]))
    const nameMap = new Map(((usersRes.data || []) as Record<string, any>[]).map((u) => [u.id, u.name]))

    const funnels = eligible.map((f) => ({
      funnel_id: f.id,
      subdomain: f.subdomain,
      coach_name: suggestedCoachName(bizMap.get(f.user_id), nameMap.get(f.user_id)),
      suggested_title: suggestedTitle(f),
    }))

    return res.status(200).json({ funnels })
  } catch (err) {
    console.error('[hub/admin/eligible-funnels] GET', err)
    return res.status(500).json({ error: 'Failed to load eligible funnels' })
  }
}
