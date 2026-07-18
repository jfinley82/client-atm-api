import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import { MatcherAnalysis } from '../../lib/matcherAnalysis'
import { stampSyncSnapshot } from '../../lib/syncDependencies'
import { requireCapability } from '../../lib/entitlements'
import { loadSynopsisInputs } from '../../lib/blueprintEnrichment'
import { generateBlueprintSynopsis } from '../../lib/blueprintSynopsis'

type FinalizeCard = {
  id: string
  card_name: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

function isFinalizeCard(v: unknown): v is FinalizeCard {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.card_name === 'string' &&
    c.card_name.trim().length > 0 &&
    typeof c.problem_text === 'string' &&
    typeof c.reasoning === 'string'
  )
}

// Save the member's final 3 (possibly edited) problems as problem_solution_cards
// rows, validated the same way the funnel builder's blueprint-completion gate
// already expects (validated: true — see lib/funnels.ts checkBlueprintComplete).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Capability gate — Steps 1-3 are the method itself, so this is method_steps
  // (every tier but free; admin bypasses), NOT the paid asset-toolkits gate.
  if (!(await requireCapability(userId, 'method_steps', res))) return

  const cards = req.body

  if (!Array.isArray(cards) || cards.length !== 3 || !cards.every(isFinalizeCard)) {
    return res.status(400).json({
      error: 'Body must be an array of exactly 3 cards, each with id, card_name, problem_text, and reasoning',
    })
  }

  try {
    const analysisRow = await getSavedOutput(userId, 'matcher_analysis')
    if (!analysisRow) return res.status(404).json({ error: 'No analysis generated yet' })

    const analysis = analysisRow.content as MatcherAnalysis
    const submittedIds = new Set(cards.map((c) => c.id))
    const selectedIds = new Set(analysis.selected_ids)

    const idsMatch =
      submittedIds.size === 3 && selectedIds.size === 3 && [...submittedIds].every((id) => selectedIds.has(id))
    if (!idsMatch) {
      return res.status(400).json({ error: 'Submitted ids must exactly match the current selected_ids' })
    }

    // matcher_analysis itself has no confirm step of its own — finalize IS the
    // confirm moment for these cards, so they're stamped against
    // matcher_analysis's OWN generation inputs (audience/transformation/
    // matcher_intake), not against matcher_analysis directly. See
    // lib/syncDependencies.ts.
    const sync_snapshot = await stampSyncSnapshot(userId, 'problem_solution_cards')

    const rows = cards.map((c) => ({
      user_id: userId,
      card_name: c.card_name,
      problem_text: c.problem_text,
      reasoning: c.reasoning,
      suggested_offer: c.suggested_offer ?? null,
      // The matcher top_10 id this card came from, so results pages can join
      // back to its match scoring (migration 033).
      source_problem_id: c.id,
      validated: true,
      sync_snapshot,
    }))

    const { data, error } = await supabase.from('problem_solution_cards').insert(rows).select()

    if (error) throw error

    // Generate each card's synopsis now so the results page is instant. Strictly
    // best-effort: a failure here (or a missing framework) must never fail the
    // finalize — the row already exists, and any card left with synopsis null
    // is regenerated lazily on the next results read (lib/blueprintEnrichment).
    const inserted = (data ?? []) as Array<{ id: string; card_name: string; problem_text: string; reasoning: string | null; suggested_offer: unknown }>
    try {
      const inputs = await loadSynopsisInputs(userId)
      await Promise.all(
        inserted.map(async (card) => {
          try {
            const synopsis = await generateBlueprintSynopsis({
              userId,
              audience: inputs.audience,
              transformation: inputs.transformation,
              framework: inputs.framework,
              card: {
                card_name: card.card_name,
                problem_text: card.problem_text,
                reasoning: card.reasoning ?? '',
                suggested_offer: card.suggested_offer,
              },
            })
            await supabase.from('problem_solution_cards').update({ synopsis }).eq('id', card.id)
            ;(card as { synopsis?: unknown }).synopsis = synopsis
          } catch (cardErr) {
            console.error('[matcher/finalize] synopsis generation failed for card', card.id, cardErr)
          }
        })
      )
    } catch (synErr) {
      console.error('[matcher/finalize] synopsis batch failed — cards saved, synopses will regenerate lazily', synErr)
    }

    return res.status(200).json(data)
  } catch (err) {
    console.error('[matcher/finalize] POST', err)
    return res.status(500).json({ error: 'Failed to save cards' })
  }
}
