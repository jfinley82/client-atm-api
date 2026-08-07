import { supabase } from './supabase'

// WHICH BOOKINGS BELONG TO A COACH. One rule, one function, stated once.
//
// Ownership is TWO facts, not one:
//
//   1. the booking's funnel is one the coach owns   (funnel_id in ownedFunnelIds)
//   2. the booking names the coach directly         (coach_user_id = caller)
//
// Fact 2 is not a refinement of fact 1. A booking made through a coach's own
// /book/:slug page has funnel_id NULL by design — it came from no funnel — so
// any list scoped on fact 1 alone cannot contain it at all. That made every
// coach-page call invisible in both the calendar and the dashboard, which is
// the whole reason this module exists rather than the rule being written twice.
//
// TWO SCOPED READS, MERGED IN CODE, deliberately not one query with .or().
// The arms are different predicates over different columns; an .or() collapses
// them into a single expression whose precedence is easy to widen by accident
// and impossible to see the width of afterwards. RLS is off on this surface, so
// this scoping IS the access control — it has to stay legible.
//
// api/bookings/[id]/attendance.ts answers the same question for a SINGLE row
// (ownsBooking) and has always used both facts. This is that rule for lists.

export type OwnedBookingsQuery = {
  /** The caller. Arm 2 matches this EXACTLY — never a join, never a subquery. */
  userId: string
  /** Funnels the caller owns, already resolved. Empty is legal and common. */
  funnelIds: string[]
  /** PostgREST column list. Must include `id` and `start_time`. */
  columns: string
  /**
   * Extra filters, applied IDENTICALLY to both arms.
   *
   * Identical is the point. A filter added to one arm only makes the two halves
   * of one union answer different questions, and the difference shows up as
   * rows that appear or vanish depending on which way they happen to be owned.
   */
  refine?: (q: any) => any
}

export async function loadOwnedActiveBookings<T = Record<string, any>>(opts: OwnedBookingsQuery): Promise<T[]> {
  const arm = () => {
    const q = supabase.from('bookings').select(opts.columns).eq('status', 'active')
    return opts.refine ? opts.refine(q) : q
  }

  // The funnel arm is SKIPPED, not sent with an empty list. Owning no funnels is
  // not the same as having no calendar — a coach with a booking page and no
  // funnel used to get an empty result permanently — and `.in('col', [])` is not
  // a query worth sending or depending on the semantics of.
  const [funnelArm, coachArm] = await Promise.all([
    opts.funnelIds.length ? arm().in('funnel_id', opts.funnelIds) : Promise.resolve({ data: [], error: null }),
    arm().eq('coach_user_id', opts.userId),
  ])
  if ((funnelArm as any).error) throw (funnelArm as any).error
  if ((coachArm as any).error) throw (coachArm as any).error

  // Deduplicated by id: a funnel booking that also carries coach_user_id is
  // returned by BOTH arms and is ONE call, not two. api/calendar/book.ts sets
  // both on every funnel booking it creates, so this is the normal case going
  // forward even though no such row exists in production yet.
  const byId = new Map<string, any>()
  for (const b of [...(((funnelArm as any).data || []) as any[]), ...(((coachArm as any).data || []) as any[])]) {
    if (b && typeof b.id === 'string' && !byId.has(b.id)) byId.set(b.id, b)
  }

  // Sorted HERE, because merging two individually-sorted lists does not produce
  // a sorted list and every caller documents its output as ascending.
  return [...byId.values()].sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''))) as T[]
}
