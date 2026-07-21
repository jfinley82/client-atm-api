import { supabase } from './supabase'
import { requireActiveUser } from './auth'

/**
 * Access gate for the Funnel Builder. Mirrors the inline membership_tier gate
 * used in api/generate and api/tools/chat (fetch the user, check an entitlement
 * field, 403 on failure).
 *
 * Phase 1 widens the gate: access is granted if ANY of these hold —
 *   - role === 'admin'                    (admins always pass, same as elsewhere)
 *   - membership_tier === 'full'          (the tier that bundles the builder)
 *   - add_ons.funnel_builder === true     (the standalone add-on purchase)
 * The three fields are fetched in one query.
 *
 * Composes requireActiveUser: verifies the session + active account first,
 * then access. Writes the error response and returns null on failure
 * (401 Unauthorized / 403 account_suspended / 403 funnel_builder_required);
 * returns the userId on success. The failure shape is unchanged.
 */
export async function requireFunnelBuilder(req: any, res: any): Promise<string | null> {
  const userId = await requireActiveUser(req, res)
  if (!userId) return null

  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier, role, add_ons')
    .eq('id', userId)
    .single()

  const hasAccess =
    gateUser?.role === 'admin' ||
    gateUser?.membership_tier === 'full' ||
    gateUser?.add_ons?.funnel_builder === true

  if (!hasAccess) {
    res.status(403).json({ error: 'funnel_builder_required' })
    return null
  }

  return userId
}

// The three MTM blueprint sessions a member completes before building a funnel.
export const BLUEPRINT_SESSIONS = ['audience', 'transformation', 'problem_solution'] as const

/**
 * Blueprint completion gate, used only on funnel creation.
 *
 * Adapted to how the blueprint is actually stored in this codebase (the prompt
 * assumed a users.saved_outputs JSONB with per-session `.completed` flags — that
 * does not exist here):
 *   - audience / transformation  -> a row in the saved_outputs table
 *   - problem_solution           -> a validated problem_solution_cards row
 *     (the "matcher" session's output; validated:true is set when the pair is done)
 *
 * Returns which sessions are still missing so the frontend can show a checklist.
 */
export async function checkBlueprintComplete(
  userId: string
): Promise<{ complete: boolean; missing: string[] }> {
  const [{ data: outputs }, { data: cards }] = await Promise.all([
    supabase.from('saved_outputs').select('tool_type, content').eq('user_id', userId),
    supabase
      .from('problem_solution_cards')
      .select('id')
      .eq('user_id', userId)
      .eq('validated', true)
      .limit(1),
  ])

  // Completion is an explicit flag in the saved_outputs content, not row
  // existence: audience/transformation are now persisted every turn, so a row
  // appears after the first message. content.completed === true is set only when
  // the session genuinely finishes. The problem_solution leg already checks a
  // real completion boolean (problem_solution_cards.validated, set only at
  // matcher finalize), so it needs no equivalent guard.
  const completedTypes = new Set(
    (outputs || []).filter((o: any) => o.content?.completed === true).map((o: any) => o.tool_type)
  )
  const done: Record<string, boolean> = {
    audience: completedTypes.has('audience'),
    transformation: completedTypes.has('transformation'),
    problem_solution: (cards || []).length > 0,
  }

  const missing = BLUEPRINT_SESSIONS.filter((s) => !done[s])
  return { complete: missing.length === 0, missing }
}

/**
 * Resolve the blueprint card behind a generation_id, scoped to the owner.
 * Verifies the mtm_generations row belongs to userId, then loads the
 * problem_solution_cards row it was built from. Returns null when the
 * generation does not exist / is not owned / has no card. Used on funnel
 * creation to snapshot the blueprint's problem/solution.
 */
export async function resolveGenerationCard(
  userId: string,
  generationId: string
): Promise<Record<string, any> | null> {
  const { data: gen } = await supabase
    .from('mtm_generations')
    .select('id, user_id, card_id')
    .eq('id', generationId)
    .maybeSingle()

  if (!gen || gen.user_id !== userId || !gen.card_id) return null

  const { data: card } = await supabase
    .from('problem_solution_cards')
    .select('id, card_name, surface_problem, real_problem, your_solution, transformation, natural_bridge, hook_angle')
    .eq('id', gen.card_id)
    .maybeSingle()

  return card ?? null
}

/**
 * Resolve a LIVE funnel for the public pages, by subdomain or by id. Returns the
 * full row, or null when it is missing or not live. The public renderer and the
 * lead endpoint both gate on status === 'live' through this one place.
 */
export async function resolveLiveFunnel(opts: {
  subdomain?: string | null
  funnelId?: string | null
}): Promise<Record<string, any> | null> {
  let query = supabase.from('funnels').select('*')
  if (opts.funnelId) query = query.eq('id', opts.funnelId)
  else if (opts.subdomain) query = query.eq('subdomain', opts.subdomain)
  else return null

  const { data: funnel } = await query.maybeSingle()
  if (!funnel || funnel.status !== 'live') return null
  return funnel
}

// Subdomain: lowercase letters, numbers, hyphens only (no leading/trailing hyphen).
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidSubdomain(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 63 && SUBDOMAIN_RE.test(value)
}

/**
 * True if `subdomain` is already taken by a different funnel. Pass the current
 * funnel id to exclude it (so a no-op PATCH of the same subdomain is allowed).
 */
export async function subdomainTaken(subdomain: string, excludeFunnelId?: string): Promise<boolean> {
  let query = supabase.from('funnels').select('id').eq('subdomain', subdomain)
  if (excludeFunnelId) query = query.neq('id', excludeFunnelId)
  const { data } = await query.limit(1)
  return (data || []).length > 0
}
