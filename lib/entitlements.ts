import { supabase } from './supabase'

// Single source of truth for what each membership_tier can do — the
// six-profile model (admin, beta, full, low_ticket, workshop, free) built on
// the existing users.membership_tier field, with role='admin' orthogonal.
// Changing who gets a capability is a one-line edit to this map; endpoints
// call requireCapability and never hardcode tier lists themselves (the old
// inline `['low_ticket','full'].includes(...)` blocks this replaces).
//
// Deliberately NOT in this model: the Funnel Builder add-on
// (add_ons.funnel_builder via lib/funnels.ts requireFunnelBuilder) — a
// standalone purchase orthogonal to tier, unchanged.

export type MembershipTier = 'free' | 'low_ticket' | 'full' | 'beta' | 'workshop'

export type Capability = 'app_login' | 'toolkits' | 'office_hours' | 'method_steps'

const CAPABILITY_TIERS: Record<Capability, MembershipTier[]> = {
  // Everyone with a real membership can log in; free means no app access.
  // workshop is deliberately here despite being unpaid — that's the tier's
  // whole point (drip access now, upgrade later) — which is why login gates
  // on this capability instead of has_paid.
  app_login: ['low_ticket', 'full', 'beta', 'workshop'],
  // All AI generation AND confirm/save. low_ticket ($27) deliberately
  // excluded — the six-profile model gives entry-level no toolkits at all.
  toolkits: ['beta', 'full'],
  // Events list + RSVP.
  office_hours: ['beta', 'full'],
  // The method/course, steps 1-3, blueprints, my-micro-trainings. workshop
  // gets this fully for now — per-item drip via unlock_schedule is Phase 3.
  method_steps: ['low_ticket', 'full', 'beta', 'workshop'],
}

// Pure check for callers that already hold the user's fields (e.g. login,
// which has the row in hand before any session exists). Admins pass every
// capability regardless of their own tier.
export function hasCapability(
  tier: string | null | undefined,
  role: string | null | undefined,
  capability: Capability
): boolean {
  if (role === 'admin') return true
  return (CAPABILITY_TIERS[capability] as string[]).includes(tier ?? '')
}

// Endpoint gate for already-authenticated requests. Fetches the user's tier +
// role once and checks the capability; on failure writes the standard
// 403 { error: 'upgrade_required' } the frontend already handles and returns
// false so the caller can `if (!(await requireCapability(...))) return` —
// same usage shape as requireActiveUser/checkSyncGate.
export async function requireCapability(userId: string, capability: Capability, res: any): Promise<boolean> {
  const { data: user } = await supabase
    .from('users')
    .select('membership_tier, role')
    .eq('id', userId)
    .single()

  if (user && hasCapability(user.membership_tier, user.role, capability)) return true

  res.status(403).json({ error: 'upgrade_required' })
  return false
}
