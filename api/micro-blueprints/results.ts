import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory, isContentComplete } from '../../lib/savedOutputs'
import { MatcherAnalysis } from '../../lib/matcherAnalysis'
import {
  loadSynopsisInputs,
  resolveScoring,
  resolveSynopsis,
  BlueprintCardRow,
} from '../../lib/blueprintEnrichment'

// GET /api/micro-blueprints/results — read-only assembly of the member's own
// Micro-Blueprints output page. requireActiveUser only, no tier gate (a read of
// the member's already-generated content). Sections: audience, transformation,
// framework, blueprints, core_offers, runner_ups — each with a `status`.
//
// Each blueprint also carries match_strength / match_factors (joined from
// matcher_analysis.top_10 via the card's source_problem_id, with a problem_text
// fallback) and its synopsis (regenerated + persisted lazily if null).
//
// 60s headroom: the FIRST load for a member with null synopses regenerates up
// to 3 of them inline (~8s), under the frontend's loading state; every load
// after that is ~0.5s. The ceiling keeps that first cold call clear of a timeout.
export const config = { maxDuration: 60 }

type SectionStatus = 'ready' | 'none'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const [audienceRow, transformationRow, frameworkRow, coreOffersRow, programRow, matcherRow, cardsRes] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'transformation_analysis'),
      getSavedOutput(userId, 'framework'),
      getSavedOutput(userId, 'core_offers'),
      getSavedOutput(userId, 'program'),
      getSavedOutput(userId, 'matcher_analysis'),
      supabase
        .from('problem_solution_cards')
        .select('id, card_name, problem_text, reasoning, suggested_offer, source_problem_id, synopsis')
        .eq('user_id', userId)
        .eq('validated', true)
        .order('created_at', { ascending: true }),
    ])
    if (cardsRes.error) throw cardsRes.error

    const audience = audienceRow ? stripSessionHistory(audienceRow.content) : null
    const audienceReady = isContentComplete(audienceRow?.content)

    const analysis = (transformationRow?.content ?? null) as { confirmed?: boolean } | null
    const transformationReady = analysis?.confirmed === true

    const framework = (frameworkRow?.content ?? null) as { confirmed?: boolean } | null
    const frameworkReady = framework?.confirmed === true

    const coreOffers = (coreOffersRow?.content ?? null) as { confirmed?: boolean } | null
    const coreOffersReady = coreOffers?.confirmed === true

    const program = (programRow?.content ?? null) as { confirmed?: boolean } | null
    const programReady = program?.confirmed === true

    const matcher = (matcherRow?.content ?? null) as MatcherAnalysis | null
    const cards = (cardsRes.data || []) as BlueprintCardRow[]

    // Enrich each blueprint with scoring + synopsis (lazy regen runs in parallel).
    const inputs = await loadSynopsisInputs(userId)
    const blueprintItems = await Promise.all(
      cards.map(async (card) => {
        const scoring = resolveScoring(card, matcher)
        const synopsis = await resolveSynopsis(userId, card, inputs)
        return {
          id: card.id,
          card_name: card.card_name,
          problem_text: card.problem_text,
          reasoning: card.reasoning,
          suggested_offer: card.suggested_offer,
          match_strength: scoring.match_strength,
          match_factors: scoring.match_factors,
          synopsis,
        }
      })
    )

    // runner_ups: top_10 minus the 3 selected, keeping their scoring.
    const selected = new Set(matcher?.selected_ids ?? [])
    const runnerUps = (matcher?.top_10 ?? [])
      .filter((p) => !selected.has(p.id))
      .map((p) => ({
        id: p.id,
        problem: p.problem,
        reasoning: p.reasoning,
        match_factors: p.match_factors,
        match_strength: p.match_strength,
      }))

    const status = (ready: boolean): SectionStatus => (ready ? 'ready' : 'none')

    return res.status(200).json({
      audience: { status: status(audienceReady), profile: audienceReady ? audience : null },
      transformation: { status: status(transformationReady), analysis: transformationReady ? analysis : null },
      framework: { status: status(frameworkReady), framework: frameworkReady ? framework : null },
      blueprints: { status: status(cards.length > 0), items: blueprintItems },
      core_offers: { status: status(coreOffersReady), core_offers: coreOffersReady ? coreOffers : null },
      program: { status: status(programReady), program: programReady ? program : null },
      runner_ups: { status: status(!!matcher), items: runnerUps },
    })
  } catch (err) {
    console.error('[micro-blueprints/results] GET', err)
    return res.status(500).json({ error: 'Failed to load results' })
  }
}
