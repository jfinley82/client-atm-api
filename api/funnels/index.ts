import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import {
  requireFunnelBuilder,
  checkBlueprintComplete,
  isValidSubdomain,
  subdomainTaken,
} from '../../lib/funnels'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  // GET — list the authenticated user's funnels
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('funnels')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return res.status(200).json({ funnels: data || [] })
    } catch (err) {
      console.error('[funnels] GET', err)
      return res.status(500).json({ error: 'Failed to load funnels' })
    }
  }

  // POST — create a funnel (blueprint must be complete first)
  if (req.method === 'POST') {
    const { complete, missing } = await checkBlueprintComplete(userId)
    if (!complete) {
      return res.status(403).json({ error: 'blueprint_incomplete', missing })
    }

    const { subdomain, template_id } = req.body || {}

    // subdomain is optional at creation (funnel starts as a draft); validate if present
    if (subdomain !== undefined && subdomain !== null) {
      if (!isValidSubdomain(subdomain)) {
        return res.status(400).json({
          error: 'invalid_subdomain',
          message: 'subdomain must be lowercase letters, numbers, and hyphens only',
        })
      }
      if (await subdomainTaken(subdomain)) {
        return res.status(409).json({ error: 'subdomain_taken' })
      }
    }

    try {
      const { data, error } = await supabase
        .from('funnels')
        .insert({
          user_id: userId,
          subdomain: subdomain ?? null,
          template_id: typeof template_id === 'string' && template_id ? template_id : 'template_1',
          // Problem/solution tagging is wired in Phase 1 (MTM Adapter); null for now.
          problem_solution_label: null,
          problem_solution_snapshot: null,
        })
        .select('*')
        .single()

      if (error) throw error
      return res.status(200).json({ funnel: data })
    } catch (err) {
      console.error('[funnels] POST', err)
      return res.status(500).json({ error: 'Failed to create funnel' })
    }
  }

  return res.status(405).end()
}
