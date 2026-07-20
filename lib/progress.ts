import { supabase } from './supabase'

export type SessionProgress = {
  key: string
  label: string
  completed: boolean
  completed_at: string | null
}

const tsOf = (row: any): string | null =>
  row ? row.updated_at || row.created_at || null : null

/**
 * MTM blueprint session progress for a member, mirroring what the member's own
 * dashboard reads (there is no single /api/progress reader — the dashboard
 * derives this from the same underlying tables):
 *   - Audience / Transformation -> saved_outputs rows (tool_type)
 *   - Matcher                    -> a problem_solution_cards row (validated
 *                                   preferred), falling back to a saved_outputs
 *                                   'matcher' row
 *   - Build (Step 4)             -> an mtm_generations row with non-empty slides
 *                                   (the coach has built at least one training)
 *   - Launch (Step 5)            -> an mtm_generations row whose emails,
 *                                   book_a_call_emails, AND workbook are all
 *                                   populated (derived from asset presence, no
 *                                   confirm/launched flag)
 *
 * Note: Transformation is stored as a single saved_outputs record; the backend
 * does not track its Part A / Part B halves separately, so it is reported as one
 * session.
 */
export async function getMtmSessionProgress(userId: string): Promise<SessionProgress[]> {
  const [{ data: outputs }, { data: cards }, { data: gens }] = await Promise.all([
    supabase.from('saved_outputs').select('tool_type, content, created_at, updated_at').eq('user_id', userId),
    supabase
      .from('problem_solution_cards')
      .select('validated, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
    supabase
      .from('mtm_generations')
      .select('created_at, updated_at, slides, emails, book_a_call_emails, workbook')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
  ])

  const outputByType = new Map<string, any>()
  for (const o of outputs || []) outputByType.set(o.tool_type, o)

  const audience = outputByType.get('audience')
  const transformation = outputByType.get('transformation')
  const matcherOutput = outputByType.get('matcher')

  // Completion is now an explicit flag stored in the saved_outputs content, NOT
  // mere row existence. Since audience/transformation are persisted on every
  // turn (so the row appears after the first message), row existence would
  // report "complete" prematurely; content.completed === true is set only when
  // the session genuinely finishes. Strict check (no fallback to existence) so
  // the funnel gate fails closed rather than unlocking early.
  const isComplete = (row: any): boolean => !!row && row.content?.completed === true

  const validatedCard = (cards || []).find((c: any) => c.validated) || null
  const anyCard = (cards || [])[0] || null
  const matcherCard = validatedCard || anyCard
  const matcherCompleted = !!matcherOutput || !!validatedCard
  const matcherAt = tsOf(matcherOutput) || tsOf(matcherCard)

  // Build (Step 4): at least one mtm_generations row has non-empty slides.
  // Launch (Step 5): at least one row has emails, book_a_call_emails, AND a
  // populated workbook. Presence-based — no confirm/launched flag. Rows come
  // ordered updated_at desc, so the first match is the most recent.
  const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0
  const workbookPopulated = (v: unknown): boolean =>
    !!v && typeof v === 'object' && nonEmptyArray((v as { sections?: unknown }).sections)
  const hasSlides = (r: any): boolean => nonEmptyArray(r.slides)
  const isLaunched = (r: any): boolean =>
    nonEmptyArray(r.emails) && nonEmptyArray(r.book_a_call_emails) && workbookPopulated(r.workbook)

  const buildRow = (gens || []).find(hasSlides) || null
  const launchRow = (gens || []).find(isLaunched) || null

  const sessions: SessionProgress[] = [
    { key: 'audience', label: 'Audience', completed: isComplete(audience), completed_at: isComplete(audience) ? tsOf(audience) : null },
    { key: 'transformation', label: 'Transformation', completed: isComplete(transformation), completed_at: isComplete(transformation) ? tsOf(transformation) : null },
    { key: 'matcher', label: 'Matcher', completed: matcherCompleted, completed_at: matcherAt },
    { key: 'build', label: 'Build', completed: !!buildRow, completed_at: buildRow ? tsOf(buildRow) : null },
    { key: 'launch', label: 'Launch', completed: !!launchRow, completed_at: launchRow ? tsOf(launchRow) : null },
  ]

  // Backfill: the funnel makes it structurally impossible to have reached a
  // later step without finishing every earlier one, so a later step being
  // complete means every earlier step must display as complete too — even if
  // its own saved_outputs row was since cleared by a Restart. Without this, a
  // step that's genuinely done (proven by real downstream artifacts) can
  // render locked behind an earlier step that only LOOKS incomplete because
  // its row was deleted, not because the work was undone.
  //
  // This is a display-only correction for step-unlock/checklist reads. It does
  // NOT relax the analyze endpoints' own prerequisite checks (checkAudienceComplete
  // etc. in lib/toolkitsShared.ts) — those read the real saved_outputs rows
  // directly, independently of this function, and correctly keep requiring the
  // actual content because generation consumes it, not just a boolean.
  let laterComplete = false
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].completed) {
      laterComplete = true
    } else if (laterComplete) {
      sessions[i] = { ...sessions[i], completed: true }
    }
  }

  return sessions
}

// ── Journey ─────────────────────────────────────────────────────────────────
// The authoritative five-step UI journey (Attract, Transform, Monetize, Build,
// Launch) so the frontend stops re-deriving step completion. Distinct from
// `sessions` (which is the finer-grained session checklist). Each step's
// completion is derived from the same underlying reads; a later step being
// complete backfills earlier steps (the funnel makes skipping impossible).
export type JourneyStep = { key: string; number: number; complete: boolean }
export type JourneySignals = {
  audience_complete: boolean
  transformation_complete: boolean
  framework_confirmed: boolean
  matcher_validated: boolean
  core_offers_confirmed: boolean
  program_confirmed: boolean
  build_ready: boolean
  launch_ready: boolean
}
// Step 4 (Build) gate. Build is accessible only when the monetize step is
// complete AND a blueprint is selected; the review screen (where selection
// happens) is reachable once monetize is complete. This is an ADDITIONAL signal
// the frontend enforces — it does not change step completion or unlocked_through.
export type BuildGate = { blueprint_selected: boolean; selected_card_id: string | null }
export type MtmJourney = {
  total_steps: number
  current_step: number
  unlocked_through: number
  steps: JourneyStep[]
  signals: JourneySignals
  build_gate: BuildGate
}

export async function getMtmJourney(userId: string): Promise<MtmJourney> {
  const [{ data: outputs }, { data: cards }, { data: gens }] = await Promise.all([
    supabase.from('saved_outputs').select('tool_type, content').eq('user_id', userId),
    supabase.from('problem_solution_cards').select('id').eq('user_id', userId).eq('validated', true).limit(1),
    supabase
      .from('mtm_generations')
      .select('card_id, slides, emails, book_a_call_emails, workbook')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
  ])

  const byType = new Map<string, any>()
  for (const o of outputs || []) byType.set(o.tool_type, o.content)
  const flag = (tool: string, key: string): boolean => byType.get(tool)?.[key] === true

  const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0
  const workbookPopulated = (v: unknown): boolean =>
    !!v && typeof v === 'object' && nonEmptyArray((v as { sections?: unknown }).sections)

  const signals: JourneySignals = {
    audience_complete: flag('audience', 'completed'),
    transformation_complete: flag('transformation', 'completed'),
    framework_confirmed: flag('framework', 'confirmed'),
    matcher_validated: (cards || []).length > 0,
    core_offers_confirmed: flag('core_offers', 'confirmed'),
    program_confirmed: flag('program', 'confirmed'),
    build_ready: (gens || []).some((g: any) => nonEmptyArray(g.slides)),
    launch_ready: (gens || []).some(
      (g: any) => workbookPopulated(g.workbook) && nonEmptyArray(g.emails) && nonEmptyArray(g.book_a_call_emails)
    ),
  }

  const steps: JourneyStep[] = [
    { key: 'attract', number: 1, complete: signals.audience_complete },
    { key: 'transform', number: 2, complete: signals.transformation_complete && signals.framework_confirmed },
    { key: 'monetize', number: 3, complete: signals.matcher_validated && signals.core_offers_confirmed && signals.program_confirmed },
    { key: 'build', number: 4, complete: signals.build_ready },
    { key: 'launch', number: 5, complete: signals.launch_ready },
  ]

  // Monotonic backfill — a later completed step marks earlier steps complete,
  // same rule as the session backfill above.
  let laterComplete = false
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].complete) laterComplete = true
    else if (laterComplete) steps[i] = { ...steps[i], complete: true }
  }

  // First incomplete step (1..5), or 5 when everything is complete. Step N is
  // accessible once 1..N-1 are complete, so unlocked_through == current_step.
  const firstIncomplete = steps.find((s) => !s.complete)?.number ?? 5

  // Build gate: the explicit build_selection wins; otherwise an already-built
  // training (most-recent mtm_generations row with slides — gens is ordered
  // updated_at desc) counts as selected; else nothing is selected.
  const selectionCardId = byType.get('build_selection')?.card_id
  const builtCardId = (gens || []).find((g: any) => nonEmptyArray(g.slides))?.card_id
  const selected_card_id =
    typeof selectionCardId === 'string' && selectionCardId.length > 0
      ? selectionCardId
      : typeof builtCardId === 'string'
        ? builtCardId
        : null

  return {
    total_steps: 5,
    current_step: firstIncomplete,
    unlocked_through: firstIncomplete,
    steps,
    signals,
    build_gate: { blueprint_selected: selected_card_id != null, selected_card_id },
  }
}
