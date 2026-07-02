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
    supabase.from('saved_outputs').select('tool_type, created_at, updated_at').eq('user_id', userId),
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

  const validatedCard = (cards || []).find((c: any) => c.validated) || null
  const anyCard = (cards || [])[0] || null
  const matcherCard = validatedCard || anyCard
  const matcherCompleted = !!matcherOutput || !!validatedCard
  const matcherAt = tsOf(matcherOutput) || tsOf(matcherCard)

  const generation = (gens || [])[0] || null

  return [
    { key: 'audience', label: 'Audience', completed: !!audience, completed_at: tsOf(audience) },
    { key: 'transformation', label: 'Transformation', completed: !!transformation, completed_at: tsOf(transformation) },
    { key: 'matcher', label: 'Matcher', completed: matcherCompleted, completed_at: matcherAt },
    { key: 'blueprint', label: 'Blueprint Generation', completed: !!generation, completed_at: generation ? generation.created_at : null },
  ]
}
