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
 *   - Blueprint generation       -> an mtm_generations row
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
      .select('created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1),
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

  const generation = (gens || [])[0] || null

  const sessions: SessionProgress[] = [
    { key: 'audience', label: 'Audience', completed: isComplete(audience), completed_at: isComplete(audience) ? tsOf(audience) : null },
    { key: 'transformation', label: 'Transformation', completed: isComplete(transformation), completed_at: isComplete(transformation) ? tsOf(transformation) : null },
    { key: 'matcher', label: 'Matcher', completed: matcherCompleted, completed_at: matcherAt },
    { key: 'blueprint', label: 'Blueprint Generation', completed: !!generation, completed_at: generation ? generation.created_at : null },
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
