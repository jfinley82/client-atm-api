import { supabase } from './supabase'
import { getSavedOutput, saveOutput, isContentComplete } from './savedOutputs'
import { FrameworkAnalysis } from './frameworkAnalysis'
import { CoreOffersAnalysis } from './coreOffersAnalysis'

// Shared gating/storage scaffold for the 4 Toolkits (program, content, slides,
// qualifier). Small, focused, single-purpose checks — composed explicitly by
// each endpoint per its own prerequisites, not one generic dispatcher — so
// each endpoint's gate list still reads as an explicit checklist (matching
// api/matcher/core-offers/analyze.ts's existing style) while the actual
// Supabase query + type-cast logic for each precondition exists exactly once.

export type GateFailure = { ok: false; error: string }

export async function checkAudienceComplete(userId: string): Promise<GateFailure | { ok: true }> {
  const row = await getSavedOutput(userId, 'audience')
  if (!isContentComplete(row?.content)) return { ok: false, error: 'audience_incomplete' }
  return { ok: true }
}

export async function checkFrameworkConfirmed(
  userId: string
): Promise<GateFailure | { ok: true; framework: FrameworkAnalysis }> {
  const row = await getSavedOutput(userId, 'framework')
  const framework = row?.content as FrameworkAnalysis | undefined
  if (!framework || framework.confirmed !== true) return { ok: false, error: 'framework_not_confirmed' }
  return { ok: true, framework }
}

export async function checkCoreOffersConfirmed(
  userId: string
): Promise<GateFailure | { ok: true; coreOffers: CoreOffersAnalysis }> {
  const row = await getSavedOutput(userId, 'core_offers')
  const coreOffers = row?.content as CoreOffersAnalysis | undefined
  if (!coreOffers || coreOffers.confirmed !== true) return { ok: false, error: 'core_offers_not_confirmed' }
  return { ok: true, coreOffers }
}

export type ValidatedBlueprint = {
  id: string
  card_name: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

// Checks the SPECIFIC member-selected card_id, not just "does the user have
// ANY validated card" — a generic existence check would let a request pass a
// card_id that's unvalidated or belongs to someone else. Scoped to user_id AND
// validated=true so both cases fail closed.
export async function getValidatedBlueprint(
  userId: string,
  cardId: unknown
): Promise<GateFailure | { ok: true; card: ValidatedBlueprint }> {
  if (typeof cardId !== 'string' || cardId.trim().length === 0) {
    return { ok: false, error: 'card_id_required' }
  }
  const { data, error } = await supabase
    .from('problem_solution_cards')
    .select('id, card_name, problem_text, reasoning, suggested_offer')
    .eq('user_id', userId)
    .eq('id', cardId)
    .eq('validated', true)
    .maybeSingle()
  if (error) throw error
  if (!data) return { ok: false, error: 'no_validated_blueprint' }
  return { ok: true, card: data as ValidatedBlueprint }
}

// Per-card_id storage wrapper for Slides/Qualifier — both key their content by
// problem_solution_cards.id inside ONE saved_outputs row (see the Toolkits
// Architecture Reference, Section 5c/5d) rather than a new one-to-many table,
// so a fresh generate/confirm for one card never wipes another card's entry.
export type ByCardIdContent<T> = { by_card_id: Record<string, T> }

export async function getByCardIdEntry<T>(userId: string, toolType: string, cardId: string): Promise<T | null> {
  const row = await getSavedOutput(userId, toolType)
  const content = row?.content as ByCardIdContent<T> | undefined
  return content?.by_card_id?.[cardId] ?? null
}

export async function saveByCardIdEntry<T>(
  userId: string,
  toolType: string,
  cardId: string,
  entry: T
): Promise<ByCardIdContent<T>> {
  const row = await getSavedOutput(userId, toolType)
  const prior = (row?.content as ByCardIdContent<T> | undefined)?.by_card_id ?? {}
  const updated: ByCardIdContent<T> = { by_card_id: { ...prior, [cardId]: entry } }
  await saveOutput(userId, toolType, updated)
  return updated
}
