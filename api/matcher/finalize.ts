import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import { MatcherAnalysis } from '../../lib/matcherAnalysis'
import { stampSyncSnapshot } from '../../lib/syncDependencies'
import { requireCapability } from '../../lib/entitlements'

// 60s headroom in case a future path here does slow work. Synopsis generation
// is deliberately NOT done here anymore (it's lazy — see below), so finalize is
// fast today, but this keeps the ceiling well clear of any Anthropic latency.
export const config = { maxDuration: 60 }

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

    // Finalize REPLACES the validated set — it never appends. Re-finalizing
    // leaves the user with exactly these 3, so the downstream "exactly 3
    // validated blueprints" gate (core_offers / program) can't be broken by
    // accumulated duplicates from repeat finalizes. finalize_blueprints
    // (migration 034) deletes the caller's existing validated=true rows and
    // inserts the new batch in ONE transaction, so a failed insert rolls back
    // the delete — the user is never left with 0 validated cards. Only the
    // caller's own validated rows are removed; drafts and other users' rows are
    // untouched. Returns the inserted rows, same shape as the prior insert.
    const cardPayload = cards.map((c) => ({
      card_name: c.card_name,
      problem_text: c.problem_text,
      reasoning: c.reasoning,
      suggested_offer: c.suggested_offer ?? null,
      // The matcher top_10 id this card came from, so results pages can join
      // back to its match scoring (migration 033).
      source_problem_id: c.id,
    }))

    const { data, error } = await supabase.rpc('finalize_blueprints', {
      p_user_id: userId,
      p_cards: cardPayload,
      p_sync_snapshot: sync_snapshot,
    })

    if (error) throw error

    // Synopsis generation is intentionally NOT done here — it's ~3 Sonnet calls
    // (~8s) and would make the Step 3 finalize slow and risk a timeout. Each
    // card's synopsis is generated lazily on the first results/my-micro-trainings
    // read (resolveSynopsis in lib/blueprintEnrichment), where a loading state
    // absorbs the one-time cost. source_problem_id is persisted above so that
    // lazy pass can still join back to the match scoring.
    return res.status(200).json(data)
  } catch (err) {
    console.error('[matcher/finalize] POST', err)
    return res.status(500).json({ error: 'Failed to save cards' })
  }
}
