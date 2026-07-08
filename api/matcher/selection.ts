import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, saveOutput } from '../../lib/savedOutputs'
import { generateSuggestedOffer, MatcherAnalysis, MatcherIntake, SuggestedOffer } from '../../lib/matcherAnalysis'
import { GenerationParseError } from '../../lib/aiJson'

// Accept the AI's 3 recommended problems as-is, or swap any of them for a
// different one of the remaining 7. Recomputes suggested_offer only for
// newly-selected ids (reuses already-generated ones, drops ids no longer
// selected) since a swap can trigger a fresh Anthropic call.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Tier gate — a swap may trigger a new suggested_offer generation call
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const selectedIds = body.selected_ids

  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length !== 3 ||
    !selectedIds.every((id): id is string => typeof id === 'string') ||
    new Set(selectedIds).size !== 3
  ) {
    return res.status(400).json({ error: 'selected_ids must be an array of exactly 3 distinct ids' })
  }
  const ids = selectedIds as string[]

  try {
    const [analysisRow, intakeRow] = await Promise.all([
      getSavedOutput(userId, 'matcher_analysis'),
      getSavedOutput(userId, 'matcher_intake'),
    ])

    if (!analysisRow) return res.status(404).json({ error: 'No analysis generated yet' })
    if (!intakeRow) return res.status(400).json({ error: 'intake_incomplete' })

    const analysis = analysisRow.content as MatcherAnalysis
    const intake = intakeRow.content as MatcherIntake
    const byId = new Map(analysis.top_10.map((p) => [p.id, p]))

    const unknownId = ids.find((id) => !byId.has(id))
    if (unknownId) {
      return res.status(400).json({ error: `Unknown problem id: ${unknownId}` })
    }

    const nextOffers: Record<string, SuggestedOffer> = {}
    await Promise.all(
      ids.map(async (id) => {
        if (analysis.suggested_offers[id]) {
          nextOffers[id] = analysis.suggested_offers[id]
          return
        }
        const problem = byId.get(id)!
        nextOffers[id] = await generateSuggestedOffer(problem, intake)
      })
    )

    const updated: MatcherAnalysis = {
      ...analysis,
      selected_ids: ids,
      suggested_offers: nextOffers,
    }

    await saveOutput(userId, 'matcher_analysis', updated)

    return res.status(200).json(updated)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[matcher/selection] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[matcher/selection] POST', err)
    return res.status(500).json({ error: 'Selection failed' })
  }
}
