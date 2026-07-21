import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'
import { landingPageHasCopy } from '../../../lib/funnelLanding'

// The public host funnels are served under.
const FUNNEL_DOMAIN = 'microtrainingmethod.com'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // Confirm ownership before publishing (404 rather than leak existence)
  const { data: funnel, error: loadError } = await supabase
    .from('funnels')
    .select('id, user_id, subdomain, landing_page, published_at')
    .eq('id', id)
    .maybeSingle()

  if (loadError) {
    console.error('[funnels/[id]/publish] load', loadError)
    return res.status(500).json({ error: 'Failed to load funnel' })
  }
  if (!funnel || funnel.user_id !== userId) {
    return res.status(404).json({ error: 'Funnel not found' })
  }

  // Readiness gate — a live funnel must have a subdomain to route on and landing
  // copy to show. Report exactly what's missing so the studio can prompt for it.
  const missing: string[] = []
  if (!funnel.subdomain) missing.push('subdomain')
  if (!landingPageHasCopy(funnel.landing_page)) missing.push('landing_page')
  if (missing.length > 0) {
    return res.status(400).json({ error: 'not_ready', missing })
  }

  try {
    // Set published_at only on first publish; a re-publish keeps the original.
    const publishedAt = funnel.published_at || new Date().toISOString()
    const { data, error } = await supabase
      .from('funnels')
      .update({ status: 'live', published_at: publishedAt, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) throw error
    const url = `https://${data.subdomain}.${FUNNEL_DOMAIN}`
    return res.status(200).json({ funnel: data, url })
  } catch (err) {
    console.error('[funnels/[id]/publish] POST', err)
    return res.status(500).json({ error: 'Failed to publish funnel' })
  }
}
