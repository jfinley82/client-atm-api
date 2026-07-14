import { SYNC_DEPENDENCIES, SyncDependencyKey, SyncableToolType, computeStaleness } from './syncDependencies'

// Maps a dependency key to the tool_type that would show up in stale_items
// when that dependency is out of date — only dependencies that are
// THEMSELVES evaluated for staleness (i.e. appear as a tool_type in
// computeStaleness's stale_items) belong here. Root dependencies
// (audience, transformation, matcher_intake) are never evaluated for
// staleness on their own, so they're deliberately omitted — a tool whose
// only dependencies are roots can never be blocked. blueprints and card
// both resolve to 'problem_solution_cards', since that's the single
// batch-level check computeStaleness performs for the validated Blueprint
// set (see syncDependencies.ts's `problem_solution_cards` handling).
const DEP_TO_TOOL_TYPE: Partial<Record<SyncDependencyKey, SyncableToolType>> = {
  transformation_analysis: 'transformation_analysis',
  framework: 'framework',
  core_offers: 'core_offers',
  blueprints: 'problem_solution_cards',
  card: 'problem_solution_cards',
}

// Derived mechanically from SYNC_DEPENDENCIES rather than hand-duplicated —
// keeps this list correct if the dependency map ever changes.
function blockingToolTypesFor(toolType: SyncableToolType): SyncableToolType[] {
  const mapped = SYNC_DEPENDENCIES[toolType].map((dep) => DEP_TO_TOOL_TYPE[dep]).filter(Boolean) as SyncableToolType[]
  return Array.from(new Set(mapped))
}

export type SyncGateResult =
  | { ok: true }
  | { ok: false; blocking: SyncableToolType[]; stale_items: Awaited<ReturnType<typeof computeStaleness>>['stale_items'] }

// Generating/regenerating `toolType` is only blocked when one of ITS OWN
// direct dependencies is itself currently stale — toolType being stale
// itself never blocks re-running toolType (that's the reconciliation path).
// Tools whose only dependencies are roots (transformation_analysis,
// problem_solution_cards) always return ok:true — never gated.
export async function checkSyncGate(userId: string, toolType: SyncableToolType): Promise<SyncGateResult> {
  const blockers = blockingToolTypesFor(toolType)
  if (blockers.length === 0) return { ok: true }

  const { stale_items } = await computeStaleness(userId)
  const staleTypes = new Set(stale_items.map((s) => s.tool_type))
  const blocking = blockers.filter((b) => staleTypes.has(b))

  if (blocking.length === 0) return { ok: true }
  return { ok: false, blocking, stale_items }
}
