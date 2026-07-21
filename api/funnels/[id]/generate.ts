import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import { requireFunnelBuilder, resolveGenerationCard } from '../../../lib/funnels'
import { blueprintSnapshot, generateLandingPage, landingPageHasCopy, BlueprintSnapshot } from '../../../lib/funnelLanding'
import { GenerationParseError } from '../../../lib/aiJson'

// POST /api/funnels/[id]/generate — regenerate this funnel's landing-page copy
// on demand. Ownership-checked. Grounds on the same saved outputs as creation
// and the funnel's frozen blueprint snapshot (falls back to re-resolving the
// blueprint from generation_id if the snapshot is somehow absent). Persists the
// new landing_page and returns the funnel. Runs the landing-copy LLM inline
// (~40s), so mirror create's server headroom; the frontend still needs its own
// loading state + generous fetch timeout.
export const config = { maxDuration: 90 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const { data: funnel, error: loadError } = await supabase
    .from('funnels')
    .select('id, user_id, generation_id, problem_solution_snapshot, problem_solution_label')
    .eq('id', id)
    .maybeSingle()

  if (loadError) {
    console.error('[funnels/[id]/generate] load', loadError)
    return res.status(500).json({ error: 'Failed to load funnel' })
  }
  if (!funnel || funnel.user_id !== userId) {
    return res.status(404).json({ error: 'Funnel not found' })
  }

  // Prefer the frozen snapshot; if missing, re-resolve from the generation.
  let snapshot = funnel.problem_solution_snapshot as BlueprintSnapshot | null
  let label = funnel.problem_solution_label as string | null
  if (!snapshot || !snapshot.card_id) {
    if (typeof funnel.generation_id !== 'string' || !funnel.generation_id) {
      return res.status(400).json({ error: 'funnel_missing_blueprint' })
    }
    const card = await resolveGenerationCard(userId, funnel.generation_id)
    if (!card) return res.status(400).json({ error: 'funnel_missing_blueprint' })
    snapshot = blueprintSnapshot(card)
    label = snapshot.card_name
  }

  let landing_page
  try {
    landing_page = await generateLandingPage(userId, snapshot)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[funnels/[id]/generate] generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[funnels/[id]/generate] landing generation', err)
    return res.status(502).json({ error: 'landing_generation_failed' })
  }
  const counts = { problem: landing_page.problem_bullets.length, solution: landing_page.solution_bullets.length }
  if (!landingPageHasCopy(landing_page)) {
    console.error('[funnels/[id]/generate] landing generation incomplete', counts)
    return res.status(502).json({ error: 'landing_generation_failed' })
  }

  try {
    const { data, error } = await supabase
      .from('funnels')
      .update({
        landing_page,
        // Backfill the snapshot/label if they were re-resolved above.
        problem_solution_snapshot: snapshot,
        problem_solution_label: label,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) throw error
    return res.status(200).json({ funnel: data })
  } catch (err) {
    console.error('[funnels/[id]/generate] POST', err)
    return res.status(500).json({ error: 'Failed to regenerate landing page' })
  }
}
