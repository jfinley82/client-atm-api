import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import { requireFunnelBuilder, isValidSubdomain, subdomainTaken } from '../../../lib/funnels'

// Fields a member may update on their own funnel in Phase 0
const THEME_MODES = ['dark', 'light']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // Load the funnel and confirm ownership (404 rather than leak existence)
  const { data: funnel, error: loadError } = await supabase
    .from('funnels')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (loadError) {
    console.error('[funnels/[id]] load', loadError)
    return res.status(500).json({ error: 'Failed to load funnel' })
  }
  if (!funnel || funnel.user_id !== userId) {
    return res.status(404).json({ error: 'Funnel not found' })
  }

  if (req.method === 'GET') {
    return res.status(200).json({ funnel })
  }

  if (req.method === 'PATCH') {
    const body = req.body || {}
    const updates: Record<string, unknown> = {}

    if ('subdomain' in body) {
      const { subdomain } = body
      if (subdomain === null) {
        updates.subdomain = null
      } else {
        if (!isValidSubdomain(subdomain)) {
          return res.status(400).json({
            error: 'invalid_subdomain',
            message: 'subdomain must be lowercase letters, numbers, and hyphens only',
          })
        }
        if (subdomain !== funnel.subdomain && (await subdomainTaken(subdomain, id))) {
          return res.status(409).json({ error: 'subdomain_taken' })
        }
        updates.subdomain = subdomain
      }
    }

    if ('brand_primary_color' in body) updates.brand_primary_color = body.brand_primary_color
    if ('brand_secondary_color' in body) updates.brand_secondary_color = body.brand_secondary_color

    if ('theme_mode' in body) {
      if (!THEME_MODES.includes(body.theme_mode)) {
        return res.status(400).json({ error: 'invalid_theme_mode', message: "theme_mode must be 'dark' or 'light'" })
      }
      updates.theme_mode = body.theme_mode
    }

    if ('collect_name' in body) updates.collect_name = !!body.collect_name
    if ('collect_phone' in body) updates.collect_phone = !!body.collect_phone

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' })
    }

    updates.updated_at = new Date().toISOString()

    try {
      const { data, error } = await supabase
        .from('funnels')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId)
        .select('*')
        .single()

      if (error) throw error
      return res.status(200).json({ funnel: data })
    } catch (err) {
      console.error('[funnels/[id]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update funnel' })
    }
  }

  return res.status(405).end()
}
