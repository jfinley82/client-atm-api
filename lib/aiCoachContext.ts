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

export type AICoachContextCard = {
  id: string
  card_name: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
  synopsis: unknown
}

export type AICoachContext = {
  cards: AICoachContextCard[]
  // The diagnostic backbone: matcher_analysis already ranks the coach's
  // problems with the match factors that tell one from another — exactly what
  // the bot needs to decide whether a lead who came in on problem A is really
  // describing problem B. There is deliberately no second ranking here.
  matcher: unknown
  framework: unknown
  core_offers: unknown
  audience: unknown
}

export type AICoachBrain = {
  system_prompt: string
  context: AICoachContext
  cardIds: Set<string>
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

export async function loadAICoachContext(userId: string): Promise<AICoachContext> {
  const [{ data: cards }, matcherRow, frameworkRes, offersRes, audienceRow] = await Promise.all([
    supabase
      .from('problem_solution_cards')
      .select('id, card_name, problem_text, reasoning, suggested_offer, synopsis')
      .eq('user_id', userId)
      .eq('validated', true),
    getSavedOutput(userId, 'matcher_analysis'),
    checkFrameworkConfirmed(userId),
    checkCoreOffersConfirmed(userId),
    getSavedOutput(userId, 'audience'),
  ])

  return {
    cards: scrubLeadUnsafe(
      ((cards || []) as AICoachContextCard[]).map((c) => ({
        id: c.id,
        card_name: c.card_name,
        problem_text: c.problem_text,
        reasoning: c.reasoning,
        suggested_offer: c.suggested_offer,
        synopsis: c.synopsis,
      }))
    ),
    matcher: scrubLeadUnsafe(stripSessionHistory(matcherRow?.content ?? null)),
    framework: frameworkRes.ok ? scrubLeadUnsafe(frameworkRes.framework) : null,
    // Scrubbed for the shared keys like everything else, but its names and
    // prices pass through intact — see the note on SCRUB_EXACT.
    core_offers: offersRes.ok ? scrubLeadUnsafe(offersRes.coreOffers) : null,
    audience: scrubLeadUnsafe(stripSessionHistory(audienceRow?.content ?? null)),
  }
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

  const [saved, context] = await Promise.all([getSavedOutput(userId, 'ai_coach'), loadAICoachContext(userId)])
  const aiCoach = saved?.content as AICoachContent | undefined

  const brain: AICoachBrain = {
    // The stored persona VERBATIM — the coach's voice and their own
    // instructions to their bot. The hosted layer is added by the chat
    // endpoint, after this, and never overrides it on wording.
    system_prompt: aiCoach?.system_prompt ?? '',
    context,
    // The clamp set for routing: the chat handler validates the model's
    // resolved_card_id against this without a second query.
    cardIds: new Set(context.cards.map((c) => c.id)),
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
