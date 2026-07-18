import { supabase } from './supabase'
import { getSavedOutput, stripSessionHistory } from './savedOutputs'
import { MatcherAnalysis, MatchFactors } from './matcherAnalysis'
import { generateBlueprintSynopsis, BlueprintSynopsis } from './blueprintSynopsis'

// Shared blueprint enrichment used by both GET /api/micro-blueprints/results
// and GET /api/my-micro-trainings: joins each validated card back to its
// matcher scoring and resolves its synopsis (regenerating + persisting lazily
// when null, so legacy cards and any failed finalize-time generation self-heal).

// The card fields both readers select. source_problem_id / synopsis are the
// columns added in migration 033.
export type BlueprintCardRow = {
  id: string
  card_name: string
  problem_text: string
  reasoning: string | null
  suggested_offer: unknown
  source_problem_id: string | null
  synopsis: BlueprintSynopsis | null
}

export type BlueprintScoring = { match_strength: number | null; match_factors: MatchFactors | null }

// The audience/transformation/framework the synopsis generator is grounded in,
// plus the member's high-ticket offer for the high_ticket_pitch line.
// transformation prefers the confirmed transformation_analysis (it carries
// explicit before/after) and falls back to the raw transformation session.
export type SynopsisInputs = { audience: unknown; transformation: unknown; framework: unknown; highTicket: unknown }

export async function loadSynopsisInputs(userId: string): Promise<SynopsisInputs> {
  const [aud, tAnalysis, tRaw, fw, coreOffers] = await Promise.all([
    getSavedOutput(userId, 'audience'),
    getSavedOutput(userId, 'transformation_analysis'),
    getSavedOutput(userId, 'transformation'),
    getSavedOutput(userId, 'framework'),
    getSavedOutput(userId, 'core_offers'),
  ])
  const highTicket = (coreOffers?.content as { high_ticket?: unknown } | undefined)?.high_ticket ?? null
  return {
    audience: aud ? stripSessionHistory(aud.content) : null,
    transformation: tAnalysis?.content ?? (tRaw ? stripSessionHistory(tRaw.content) : null),
    framework: fw?.content ?? null,
    highTicket,
  }
}

// Joins a card to its matcher top_10 entry for scoring — by source_problem_id
// first, then by problem_text as a legacy fallback (older cards predate the id
// column). Unresolved -> nulls, and the card renders without the scoring block.
export function resolveScoring(card: BlueprintCardRow, analysis: MatcherAnalysis | null): BlueprintScoring {
  const top10 = analysis?.top_10 ?? []
  let match = card.source_problem_id ? top10.find((p) => p.id === card.source_problem_id) : undefined
  if (!match) match = top10.find((p) => p.problem === card.problem_text)
  if (!match) return { match_strength: null, match_factors: null }
  return { match_strength: match.match_strength, match_factors: match.match_factors }
}

// Returns the card's synopsis, regenerating + persisting it when null. Never
// throws — a generation failure resolves to null and the card renders its
// problem + scoring without the synopsis block.
export async function resolveSynopsis(
  userId: string,
  card: BlueprintCardRow,
  inputs: SynopsisInputs
): Promise<BlueprintSynopsis | null> {
  // Regenerate when the synopsis is missing entirely OR was persisted before
  // high_ticket_pitch existed (field absent -> undefined, distinct from a
  // legitimate empty '' when there's no high-ticket offer). This backfills the
  // new field on existing cards exactly once — after regen the field is a
  // string, so it won't regenerate again.
  const existingPitch = card.synopsis ? (card.synopsis as Record<string, unknown>).high_ticket_pitch : undefined
  if (card.synopsis && existingPitch !== undefined) return card.synopsis
  try {
    const synopsis = await generateBlueprintSynopsis({
      userId,
      audience: inputs.audience,
      transformation: inputs.transformation,
      framework: inputs.framework,
      highTicket: inputs.highTicket,
      card: {
        card_name: card.card_name,
        problem_text: card.problem_text,
        reasoning: card.reasoning ?? '',
        suggested_offer: card.suggested_offer,
      },
    })
    await supabase.from('problem_solution_cards').update({ synopsis }).eq('id', card.id)
    return synopsis
  } catch (err) {
    console.error('[blueprintEnrichment] lazy synopsis regen failed', card.id, err)
    return null
  }
}
