import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import {
  requireFunnelBuilder,
  checkBlueprintComplete,
  isValidSubdomain,
  subdomainTaken,
  resolveGenerationCard,
} from '../../lib/funnels'
import { blueprintSnapshot, generateLandingPage, landingPageHasCopy } from '../../lib/funnelLanding'
import { GenerationParseError } from '../../lib/aiJson'

// Creation runs the landing-copy LLM inline (~40s observed), so give the server
// generous headroom above that. This is the SERVER ceiling — the frontend still
// needs its own loading state and a generous fetch timeout on this call.
export const config = { maxDuration: 90 }

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

  // POST — create a funnel from a finished Micro-Training generation. The
  // blueprint must be complete, a valid owned generation_id is required, and the
  // landing-page copy is generated inline at creation.
  if (req.method === 'POST') {
    const { complete, missing } = await checkBlueprintComplete(userId)
    if (!complete) {
      return res.status(403).json({ error: 'blueprint_incomplete', missing })
    }

    const { subdomain, template_id, generation_id } = req.body || {}

    // generation_id is now required — it names the blueprint this funnel is for.
    if (typeof generation_id !== 'string' || !generation_id) {
      return res.status(400).json({ error: 'generation_id required' })
    }
    const card = await resolveGenerationCard(userId, generation_id)
    if (!card) {
      return res.status(400).json({ error: 'invalid_generation_id' })
    }

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

    // Freeze the blueprint's problem/solution and generate the landing copy.
    const snapshot = blueprintSnapshot(card)
    let landing_page
    try {
      landing_page = await generateLandingPage(userId, snapshot)
    } catch (err) {
      if (err instanceof GenerationParseError) {
        console.error('[funnels] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
        return res.status(502).json({ error: 'generation_truncated' })
      }
      console.error('[funnels] POST landing generation', err)
      return res.status(502).json({ error: 'landing_generation_failed' })
    }
    // Require the full publishable shape (headline + subheadline + 3+3 bullets);
    // a short generation is a miss, not something to persist.
    const counts = { problem: landing_page.problem_bullets.length, solution: landing_page.solution_bullets.length }
    if (!landingPageHasCopy(landing_page)) {
      console.error('[funnels] POST landing generation incomplete', counts)
      return res.status(502).json({ error: 'landing_generation_failed' })
    }

    try {
      const { data, error } = await supabase
        .from('funnels')
        .insert({
          user_id: userId,
          generation_id,
          subdomain: subdomain ?? null,
          template_id: typeof template_id === 'string' && template_id ? template_id : 'template_1',
          problem_solution_label: snapshot.card_name,
          problem_solution_snapshot: snapshot,
          landing_page,
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
