import { supabase } from './supabase'
import { getSavedOutput, stripSessionHistory } from './savedOutputs'
import { checkFrameworkConfirmed, checkCoreOffersConfirmed } from './toolkitsShared'
import { AICoachContent } from './aiCoach'

// The coach's ATM assembled into the map the HOSTED bot reasons over. No model
// call anywhere in this file — this is assembly.
//
// COVERAGE IS EVERY VALIDATED CARD, NOT config.card_ids. The locked plan
// (claude/ai-coach-plan-locked-2026-08-02.md) settled this: the 1-2 picked ids
// are the featured DEFAULT — what a lead sees before their problem is known —
// while coverage is all of the coach's cards, because a lead arrives on one
// funnel's problem and the conversation can move. resolveCardId() returning an
// entry card from card_ids is correct and separate. Entry is one card.
// Coverage is all of them. They are different questions.

/**
 * One card as the DIAGNOSTIC INDEX sees it: enough to route a lead to the right
 * problem, and nothing more.
 *
 * This is the lazy-load half of the cost work. Every turn used to re-send every
 * card's full synopsis; ~93% of a ~27k-token turn was that fixed prefix. The
 * routing job only needs id, name, problem, and the match factors that tell one
 * problem from another — the DEPTH (synopsis) is only needed for the card the
 * conversation is actually about, and that one goes in the volatile block.
 *
 * It composes with the caching rather than fighting it: the index is stable so
 * it caches, the resolved synopsis is volatile so it sits after the breakpoint,
 * and a pivot costs one uncached block instead of a full prefix rebuild.
 */
export type AICoachIndexCard = {
  id: string
  card_name: string
  problem_text: string
  // From matcher_analysis, joined on problem_solution_cards.source_problem_id
  // -> matcher_analysis.top_10[].id. NOT the card uuid: the matcher's own ids
  // are 'p2'/'p3'/'p5', and joining on the uuid silently yields no factors at
  // all while the code looks correct.
  match_factors: unknown
}

export type AICoachContext = {
  card_index: AICoachIndexCard[]
  framework: unknown
  core_offers: unknown
  audience: unknown
}

export type AICoachBrain = {
  system_prompt: string
  context: AICoachContext
  cardIds: Set<string>
  /** Full synopsis per card id, for the ONE resolved card the turn is about. */
  synopsisById: Map<string, unknown>
  cardNameById: Map<string, string>
}

// Keys that never reach the assembled context, wherever they appear. These are
// the coach writing to THEMSELVES: sales framing (high_ticket_pitch,
// offer_includes), internal positioning (framework_fit), raw interview
// transcripts (session_history), and a named client's private self-talk
// (client_language_*, *_internal_talk).
//
// The discipline cuts BOTH ways: core_offers is lead-safe INCLUDING prices.
// The generated persona already sells with real names and real prices, and a
// goal:'sell' bot that cannot name what it is selling is broken. That is why
// this is a targeted key scrub and not synopsis.ts's exclusion list applied
// wholesale to everything.
const SCRUB_EXACT = new Set(['high_ticket_pitch', 'offer_includes', 'framework_fit', 'session_history'])
const isScrubbedKey = (k: string): boolean =>
  SCRUB_EXACT.has(k) || k.startsWith('client_language') || k.endsWith('_internal_talk')

export function scrubLeadUnsafe<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrubLeadUnsafe) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (isScrubbedKey(k)) continue
      out[k] = scrubLeadUnsafe(val)
    }
    return out as T
  }
  return v
}

type CardRow = {
  id: string
  card_name: string
  problem_text: string
  source_problem_id: string | null
  synopsis: unknown
}

export async function loadAICoachContext(
  userId: string
): Promise<{ context: AICoachContext; synopsisById: Map<string, unknown>; cardNameById: Map<string, string> }> {
  const [{ data: cards }, matcherRow, frameworkRes, offersRes, audienceRow] = await Promise.all([
    supabase
      .from('problem_solution_cards')
      .select('id, card_name, problem_text, source_problem_id, synopsis')
      .eq('user_id', userId)
      .eq('validated', true),
    getSavedOutput(userId, 'matcher_analysis'),
    checkFrameworkConfirmed(userId),
    checkCoreOffersConfirmed(userId),
    getSavedOutput(userId, 'audience'),
  ])

  const rows = (cards || []) as CardRow[]

  // matcher_analysis.top_10[] keyed by ITS OWN id ('p2'), which the card
  // carries as source_problem_id. See AICoachIndexCard.match_factors.
  const matcherContent = (matcherRow?.content ?? null) as { top_10?: unknown } | null
  const factorsBySourceId = new Map<string, unknown>()
  const topTen = Array.isArray(matcherContent?.top_10) ? (matcherContent!.top_10 as any[]) : []
  for (const entry of topTen) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      factorsBySourceId.set(entry.id, scrubLeadUnsafe(entry.match_factors ?? null))
    }
  }

  const context: AICoachContext = {
    card_index: rows.map((c) => ({
      id: c.id,
      card_name: c.card_name,
      problem_text: c.problem_text,
      match_factors: (c.source_problem_id && factorsBySourceId.get(c.source_problem_id)) ?? null,
    })),
    framework: frameworkRes.ok ? scrubLeadUnsafe(frameworkRes.framework) : null,
    // Scrubbed for the shared keys like everything else, but its names and
    // prices pass through intact — see the note on SCRUB_EXACT.
    core_offers: offersRes.ok ? scrubLeadUnsafe(offersRes.coreOffers) : null,
    audience: scrubLeadUnsafe(stripSessionHistory(audienceRow?.content ?? null)),
  }

  // Held beside the context, NOT inside it — only the resolved card's synopsis
  // is ever serialized into a prompt.
  const synopsisById = new Map<string, unknown>()
  const cardNameById = new Map<string, string>()
  for (const c of rows) {
    synopsisById.set(c.id, scrubLeadUnsafe(c.synopsis ?? null))
    cardNameById.set(c.id, c.card_name)
  }

  return { context, synopsisById, cardNameById }
}

// Warm-instance optimisation ONLY. Serverless invocations may always be cold,
// and the endpoint must be correct when they are — this Map just saves the
// re-assembly when several turns of one conversation land on the same hot
// instance. It is keyed by the COACH's user id (many leads share one brain) and
// there is no such thing as a per-lead session to cache against.
const brainCache = new Map<string, { at: number; brain: AICoachBrain }>()
const BRAIN_TTL_MS = 5 * 60 * 1000

export async function buildAICoachBrain(userId: string): Promise<AICoachBrain> {
  const hit = brainCache.get(userId)
  if (hit && Date.now() - hit.at < BRAIN_TTL_MS) return hit.brain

  const [saved, loaded] = await Promise.all([getSavedOutput(userId, 'ai_coach'), loadAICoachContext(userId)])
  const aiCoach = saved?.content as AICoachContent | undefined

  const brain: AICoachBrain = {
    // The stored persona VERBATIM — the coach's voice and their own
    // instructions to their bot. The hosted layer is added by the chat
    // endpoint, after this, and never overrides it on wording.
    system_prompt: aiCoach?.system_prompt ?? '',
    context: loaded.context,
    // The clamp set for routing: the chat handler validates the model's
    // resolved_card_id against this without a second query.
    cardIds: new Set(loaded.context.card_index.map((c) => c.id)),
    synopsisById: loaded.synopsisById,
    cardNameById: loaded.cardNameById,
  }

  brainCache.set(userId, { at: Date.now(), brain })
  if (brainCache.size > 500) {
    for (const [k, v] of brainCache) if (Date.now() - v.at >= BRAIN_TTL_MS) brainCache.delete(k)
  }
  return brain
}

// Tests mutate their fixtures between cases faster than the TTL expires; prod
// never calls this.
export function _clearBrainCacheForTests(): void {
  brainCache.clear()
}
