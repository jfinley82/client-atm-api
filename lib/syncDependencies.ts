import { supabase } from './supabase'

// Confirmed from source (grep + read of every analyze function listed below),
// not inferred. Corrections vs. the originally assumed map, for the record:
//   - transformation_analysis reads saved_outputs('transformation') — the RAW
//     Step 2 conversation — not 'audience'. audience is never read there.
//   - matcher_analysis (api/matcher/analyze.ts) reads 'audience',
//     'transformation' (RAW, not transformation_analysis), and
//     'matcher_intake'. matcher_analysis has no confirm step of its own (no
//     `confirmed` field exists on MatcherAnalysis) — its output feeds
//     directly into matcher/finalize.ts, so problem_solution_cards inherit
//     matcher_analysis's OWN roots (audience/transformation/matcher_intake)
//     as their dependencies, rather than depending on matcher_analysis or
//     transformation_analysis.
//   - core_offers/analyze.ts also reads matcher_intake (CURRENT BUSINESS
//     CONTEXT, for the is_refinement judgment) and the 3 validated
//     problem_solution_cards (FINALIZED BLUEPRINTS, for low_ticket) — both
//     missing from the original assumed map.
//   - program/analyze.ts also reads 'audience' directly (not just framework +
//     core_offers).
//   - content/analyze.ts also reads 'core_offers' — optional context, used to
//     ground CTAs only if already confirmed, never gated on.
//   - slides/analyze.ts and qualifier/analyze.ts both read the SPECIFIC
//     validated card (blueprintGate.card) they were generated for — missing
//     from the original map entirely. slides' audience read is optional
//     (falls back to {} if no audience row exists).
//
// voice_guides is deliberately EXCLUDED even though every one of these
// generators reads it via getVoiceContext(userId) — it only shapes tone/
// style, not the underlying facts an output is built from, so editing a
// Voice Guide never marks anything stale. Flagged in the report for the user
// to confirm this judgment call.
export type SyncDependencyKey =
  | 'audience'
  | 'transformation'
  | 'matcher_intake'
  | 'transformation_analysis'
  | 'framework'
  | 'core_offers'
  | 'blueprints'
  | 'card'

export type SyncableToolType =
  | 'transformation_analysis'
  | 'framework'
  | 'core_offers'
  | 'program'
  | 'content'
  | 'slides'
  | 'qualifier'
  | 'problem_solution_cards'

export const SYNC_DEPENDENCIES: Record<SyncableToolType, SyncDependencyKey[]> = {
  transformation_analysis: ['transformation'],
  framework: ['audience', 'transformation_analysis'],
  core_offers: ['audience', 'transformation_analysis', 'framework', 'matcher_intake', 'blueprints'],
  program: ['audience', 'framework', 'core_offers'],
  content: ['audience', 'framework', 'core_offers'],
  slides: ['audience', 'framework', 'card'],
  qualifier: ['audience', 'card', 'core_offers'],
  problem_solution_cards: ['audience', 'transformation', 'matcher_intake'],
}

// tool_type keys read from saved_outputs (everything except 'blueprints' and
// 'card', which come from problem_solution_cards).
const SAVED_OUTPUT_DEP_KEYS = ['audience', 'transformation', 'matcher_intake', 'transformation_analysis', 'framework', 'core_offers'] as const

export type DependencyTimestamps = Record<Exclude<SyncDependencyKey, 'card'>, string | null>

// Fetches the CURRENT value of every possible upstream dependency in one pair
// of queries — the single place that knows how to read "what is X right now,"
// reused by both stampSyncSnapshot (one tool, at confirm time) and
// computeStaleness (all syncable items, at status-check time).
export async function getDependencyTimestamps(userId: string): Promise<DependencyTimestamps> {
  const [savedOutputsResult, cardsResult] = await Promise.all([
    supabase
      .from('saved_outputs')
      .select('tool_type, updated_at')
      .eq('user_id', userId)
      .in('tool_type', SAVED_OUTPUT_DEP_KEYS as unknown as string[]),
    supabase.from('problem_solution_cards').select('created_at').eq('user_id', userId).eq('validated', true),
  ])

  if (savedOutputsResult.error) throw savedOutputsResult.error
  if (cardsResult.error) throw cardsResult.error

  const byToolType = new Map((savedOutputsResult.data || []).map((r) => [r.tool_type as string, r.updated_at as string]))
  const cardCreatedAts = (cardsResult.data || []).map((c) => c.created_at as string).sort()
  // The Blueprint batch's own "changed" signal — the newest validated card,
  // since finalize always INSERTS a fresh batch rather than updating existing
  // rows (confirmed via source: no .update( call touches problem_solution_cards
  // anywhere in this codebase).
  const blueprints = cardCreatedAts.length > 0 ? cardCreatedAts[cardCreatedAts.length - 1] : null

  return {
    audience: byToolType.get('audience') ?? null,
    transformation: byToolType.get('transformation') ?? null,
    matcher_intake: byToolType.get('matcher_intake') ?? null,
    transformation_analysis: byToolType.get('transformation_analysis') ?? null,
    framework: byToolType.get('framework') ?? null,
    core_offers: byToolType.get('core_offers') ?? null,
    blueprints,
  }
}

// Looks up ONE specific card's own created_at — the 'card' dependency for
// slides/qualifier, which are keyed per card_id rather than per tool_type.
export async function getCardTimestamp(userId: string, cardId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('problem_solution_cards')
    .select('created_at')
    .eq('user_id', userId)
    .eq('id', cardId)
    .eq('validated', true)
    .maybeSingle()
  if (error) throw error
  return data?.created_at ?? null
}

// Stamps a snapshot of the CURRENT upstream values for one tool_type's
// dependency list — called from that tool's confirm endpoint (or
// matcher/finalize.ts for problem_solution_cards) right before saving. Only
// includes a key when that dependency currently has a value; an optional
// dependency that doesn't exist yet (e.g. core_offers before it's been
// confirmed, for content) is simply omitted, not stamped as null.
export async function stampSyncSnapshot(
  userId: string,
  toolType: SyncableToolType,
  cardId?: string
): Promise<Record<string, string>> {
  const deps = SYNC_DEPENDENCIES[toolType]
  const timestamps = await getDependencyTimestamps(userId)
  const snapshot: Record<string, string> = {}

  for (const dep of deps) {
    if (dep === 'card') {
      if (cardId) {
        const cardTs = await getCardTimestamp(userId, cardId)
        if (cardTs) snapshot.card = cardTs
      }
      continue
    }
    const value = timestamps[dep]
    if (value) snapshot[dep] = value
  }

  return snapshot
}

export type StaleItem = { tool_type: string; card_id: string | null; stale_because: string[] }

// For one syncable item's stored sync_snapshot, returns which of its CURRENT
// dependency values are newer than what was stamped — OR missing from the
// snapshot entirely, meaning that dependency didn't exist yet at confirm time
// but does now, which is itself new information the confirmed item never saw.
function findStaleDependencies(
  deps: SyncDependencyKey[],
  snapshot: Record<string, string> | undefined | null,
  timestamps: DependencyTimestamps,
  cardTimestamp: string | null
): string[] {
  const stale: string[] = []
  const snap = snapshot ?? {}
  for (const dep of deps) {
    const current = dep === 'card' ? cardTimestamp : timestamps[dep]
    if (!current) continue // dependency doesn't exist yet — nothing to compare against
    const stamped = snap[dep]
    if (!stamped || new Date(current).getTime() > new Date(stamped).getTime()) {
      stale.push(dep)
    }
  }
  return stale
}

function isConfirmedWithSnapshot(content: unknown): content is { confirmed: true; sync_snapshot: Record<string, string> } {
  if (!content || typeof content !== 'object') return false
  const c = content as Record<string, unknown>
  return c.confirmed === true && !!c.sync_snapshot && typeof c.sync_snapshot === 'object'
}

const SINGLE_ROW_ITEMS: SyncableToolType[] = ['transformation_analysis', 'framework', 'core_offers', 'program', 'content']
// Per-card items still stored in saved_outputs[tool].by_card_id. 'slides' moved
// off this list in the Task 5 consolidation — its snapshot now lives on the
// canonical mtm_generations row and is evaluated separately below.
const BY_CARD_ITEMS: SyncableToolType[] = ['qualifier']

// Only items that ACTUALLY EXIST and are CONFIRMED for this user are ever
// evaluated — an item never generated, or a draft never confirmed, never
// appears in stale_items. Items confirmed before this feature existed (no
// sync_snapshot stored) are silently skipped rather than guessed at — not
// flagged stale, not counted as in-sync either.
export async function computeStaleness(userId: string): Promise<{ in_sync: boolean; stale_items: StaleItem[] }> {
  const [savedOutputsResult, cardsResult, mtmGensResult, timestamps] = await Promise.all([
    supabase
      .from('saved_outputs')
      .select('tool_type, content')
      .eq('user_id', userId)
      .in('tool_type', [...SINGLE_ROW_ITEMS, ...BY_CARD_ITEMS]),
    supabase.from('problem_solution_cards').select('id, created_at, sync_snapshot').eq('user_id', userId).eq('validated', true),
    supabase.from('mtm_generations').select('card_id, slides, sync_snapshot').eq('user_id', userId),
    getDependencyTimestamps(userId),
  ])

  if (savedOutputsResult.error) throw savedOutputsResult.error
  if (cardsResult.error) throw cardsResult.error
  if (mtmGensResult.error) throw mtmGensResult.error

  const byToolType = new Map((savedOutputsResult.data || []).map((r) => [r.tool_type as string, r.content]))
  const validatedCards = cardsResult.data || []

  const stale_items: StaleItem[] = []

  for (const toolType of SINGLE_ROW_ITEMS) {
    const content = byToolType.get(toolType)
    if (!isConfirmedWithSnapshot(content)) continue
    const because = findStaleDependencies(SYNC_DEPENDENCIES[toolType], content.sync_snapshot, timestamps, null)
    if (because.length > 0) stale_items.push({ tool_type: toolType, card_id: null, stale_because: because })
  }

  for (const toolType of BY_CARD_ITEMS) {
    const content = byToolType.get(toolType) as { by_card_id?: Record<string, unknown> } | undefined
    if (!content?.by_card_id) continue
    for (const [cardId, entry] of Object.entries(content.by_card_id)) {
      if (!isConfirmedWithSnapshot(entry)) continue
      const cardRow = validatedCards.find((c) => c.id === cardId)
      const cardTimestamp = (cardRow?.created_at as string | undefined) ?? null
      const because = findStaleDependencies(SYNC_DEPENDENCIES[toolType], entry.sync_snapshot, timestamps, cardTimestamp)
      if (because.length > 0) stale_items.push({ tool_type: toolType, card_id: cardId, stale_because: because })
    }
  }

  // Slides — consolidated onto mtm_generations (Task 5). A card's slides are
  // staleness-evaluated when they exist and carry a stamped sync_snapshot;
  // there is no confirmed flag anymore (presence is the signal).
  for (const row of mtmGensResult.data || []) {
    const slides = (row as { slides?: unknown }).slides
    const snapshot = (row as { sync_snapshot?: unknown }).sync_snapshot
    if (!Array.isArray(slides) || slides.length === 0) continue
    if (!snapshot || typeof snapshot !== 'object') continue
    const cardId = (row as { card_id: string }).card_id
    const cardRow = validatedCards.find((c) => c.id === cardId)
    const cardTimestamp = (cardRow?.created_at as string | undefined) ?? null
    const because = findStaleDependencies(
      SYNC_DEPENDENCIES.slides,
      snapshot as Record<string, string>,
      timestamps,
      cardTimestamp
    )
    if (because.length > 0) stale_items.push({ tool_type: 'slides', card_id: cardId, stale_because: because })
  }

  // Blueprints — a single batch-level check, since there's no per-card sync
  // action (see the report: no edit-in-place flow exists for finalized
  // cards). Only evaluated when every currently-validated card was stamped —
  // a mix of stamped and pre-feature un-stamped cards can't be judged
  // consistently, so it's skipped rather than guessed at.
  if (validatedCards.length > 0 && validatedCards.every((c) => !!c.sync_snapshot)) {
    const becauseSets = validatedCards.map((c) =>
      findStaleDependencies(SYNC_DEPENDENCIES.problem_solution_cards, c.sync_snapshot as Record<string, string>, timestamps, null)
    )
    const because = Array.from(new Set(becauseSets.flat()))
    if (because.length > 0) stale_items.push({ tool_type: 'problem_solution_cards', card_id: null, stale_because: because })
  }

  return { in_sync: stale_items.length === 0, stale_items }
}
