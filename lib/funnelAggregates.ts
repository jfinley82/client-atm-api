import { supabase } from './supabase'
import { Window } from './analyticsPeriod'

// Multi-funnel count helpers, shared by every endpoint that rolls up numbers
// across a set of funnel ids (api/funnels/analytics.ts, api/funnels/portfolio.ts).
// Kept here as the ONE implementation rather than copied per-endpoint: the
// countBookingsAll fix (funnel_events 'booked' overcounted — see its comment
// below) had to land in exactly one place so every caller inherits it, not just
// whichever endpoint happened to get fixed first.

export type Kpis = { visits: number; leads: number; appointments: number; closed: number; revenue: number }
export const emptyKpis = (): Kpis => ({ visits: 0, leads: 0, appointments: 0, closed: 0, revenue: 0 })

// Count funnel_events of a type across MANY funnels at once, optionally windowed.
export async function countEventsAll(funnelIds: string[], eventType: string, w?: Window): Promise<number> {
  let q = supabase
    .from('funnel_events')
    .select('*', { count: 'exact', head: true })
    .in('funnel_id', funnelIds)
    .eq('event_type', eventType)
  if (w) q = q.gte('created_at', w.start).lt('created_at', w.end)
  const { count } = await q
  return count ?? 0
}

export async function countLeadsAll(funnelIds: string[], w?: Window): Promise<number> {
  let q = supabase.from('funnel_leads').select('*', { count: 'exact', head: true }).in('funnel_id', funnelIds)
  if (w) q = q.gte('opted_in_at', w.start).lt('opted_in_at', w.end)
  const { count } = await q
  return count ?? 0
}

// Real appointment count across many funnels — sourced from `bookings`, NOT
// funnel_events rows tagged 'booked'. That event has a second writer
// (api/funnels/[id]/leads/[leadId].ts logs one whenever a coach manually moves a
// lead's CRM status to "booked", with no calendar booking required), which
// inflated every aggregate that counted it instead of the real table.
export async function countBookingsAll(funnelIds: string[], w?: Window): Promise<number> {
  let q = supabase.from('bookings').select('*', { count: 'exact', head: true }).in('funnel_id', funnelIds)
  if (w) q = q.gte('created_at', w.start).lt('created_at', w.end)
  const { count } = await q
  return count ?? 0
}
