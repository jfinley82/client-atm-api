import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { loadOwnedActiveBookings } from '../../lib/coachBookings'
import { FUNNEL_PUBLIC_DOMAIN, funnelPublicUrl } from '../../lib/funnelDomain'

// GET /api/funnels/portfolio — the portfolio-home rollup: fleet-wide totals,
// a per-funnel row for each funnel the caller owns, upcoming calls across the
// whole fleet, and the most recent leads across the whole fleet.
//
// This is the fix for "stats only show for one funnel": every query here is
// scoped with `.in('funnel_id', funnelIds)` over ALL of the owner's funnels,
// never a single selected one. Ownership is resolved ONCE (funnels.user_id =
// caller), and every downstream query is scoped to that id set — RLS is off by
// design in this schema (API-layer auth), so this scoping IS the access control.
//
// Distinct from the two existing analytics endpoints:
//   /api/funnels/[id]/analytics — one funnel, period-over-period comparison.
//   /api/funnels/analytics      — fleet totals in THAT endpoint's own shape
//                                 (visits/leads/appointments/rates/per_funnel),
//                                 already consumed by the Overview card.
// This endpoint is a different, portfolio-home-specific shape (visitors/leads/
// calls_booked/booked_rate, flow+conversions per funnel, upcoming_calls,
// recent_leads) — added alongside rather than reshaping either existing one,
// since both already have consumers on the wire.
export const config = { maxDuration: 30 }

const UPCOMING_CALLS_LIMIT = 25
const RECENT_LEADS_LIMIT = 25

// booked_rate and the per-funnel conversion ratios are 0..1, rounded to 4
// decimal places — the same convention api/funnels/analytics.ts's `rates`
// already uses (lead_rate/appointment_rate/close_rate), so a percent display is
// a single `* 100` away and the raw ratio is still exact for math.
function ratio(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 10000) / 10000 : 0
}

// Human-readable name for the portfolio list. funnels has no dedicated `name`
// column — problem_solution_label is the short marketing label set at funnel
// creation and is what a coach actually recognizes their funnel by; the landing
// page's own headline is the next-best thing, and the subdomain is the last
// resort so this is never blank.
function funnelDisplayName(f: Record<string, any>): string {
  const label = typeof f.problem_solution_label === 'string' ? f.problem_solution_label.trim() : ''
  if (label) return label
  const headline = (f.landing_page && typeof f.landing_page === 'object' ? f.landing_page.headline : null) as unknown
  if (typeof headline === 'string' && headline.trim()) return headline.trim()
  if (typeof f.subdomain === 'string' && f.subdomain.trim()) return f.subdomain.trim()
  return 'Untitled funnel'
}

type FunnelBucket = { visitors: number; opt_ins: number; booked: number; closed: number; revenue: number }
const emptyBucket = (): FunnelBucket => ({ visitors: 0, opt_ins: 0, booked: 0, closed: 0, revenue: 0 })

// The upcoming-calls panel, defined ONCE so the zero-funnel branch and the main
// branch cannot answer differently. Both read the two ownership arms through
// lib/coachBookings.ts.
type UpcomingRow = { id: string; funnel_id: string | null; name: string | null; start_time: string }
const UPCOMING_COLUMNS = 'id, funnel_id, name, start_time'
const upcomingRefine = (nowIso: string) => (q: any) =>
  q.gte('start_time', nowIso).order('start_time', { ascending: true }).limit(UPCOMING_CALLS_LIMIT)
const toUpcoming = (row: UpcomingRow) => ({
  booking_id: row.id,
  funnel_id: row.funnel_id,
  lead_name: row.name,
  start_time: row.start_time,
})

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  try {
    // Ownership resolved once; every query below is scoped to this id set.
    const { data: funnelRows, error: funnelErr } = await supabase
      .from('funnels')
      .select('id, subdomain, status, problem_solution_label, landing_page')
      .eq('user_id', userId)
    if (funnelErr) throw funnelErr

    const funnels = funnelRows || []
    const funnelIds = funnels.map((f) => f.id as string)

    const nowIso = new Date().toISOString()

    if (funnelIds.length === 0) {
      // No funnels genuinely means no FUNNEL analytics — those totals are zero
      // and the funnel list is empty. It does NOT mean no calls: a coach with a
      // booking page and no funnel still gets booked, and upcoming_calls is a
      // list of calls rather than a statistic about a funnel. Returning it empty
      // here was the dashboard's half of the same defect.
      const rows = await loadOwnedActiveBookings<UpcomingRow>({
        userId,
        funnelIds,
        columns: UPCOMING_COLUMNS,
        refine: upcomingRefine(nowIso),
      })
      return res.status(200).json({
        totals: { visitors: 0, leads: 0, calls_booked: 0, booked_rate: 0, closed: 0, revenue: 0 },
        funnels: [],
        upcoming_calls: rows.map(toUpcoming),
        recent_leads: [],
        // THE BRANCH THAT NEEDS IT MOST. A coach with no funnels is the coach
        // typing their first subdomain, so this is exactly where the live
        // preview has nothing else to build from — and it is the branch a
        // "add the field to the response" change forgets, because the other one
        // is the one you are looking at. tests/funnelAddress.test.ts drives both.
        funnel_domain: FUNNEL_PUBLIC_DOMAIN,
      })
    }

    const [eventsRes, leadsRes, bookingsRes, upcomingRows, recentLeadsRes] = await Promise.all([
      // Per-funnel visitor bucketing needs the rows, not a head:true count —
      // one query serves both the fleet total (rows.length) and the per-funnel
      // split, instead of N+1 count queries.
      supabase.from('funnel_events').select('funnel_id').in('funnel_id', funnelIds).eq('event_type', 'landing_view'),
      // Same reasoning: every lead's funnel_id/status/close_amount in one pull
      // gives opt-ins, closed, and revenue — fleet-wide and per-funnel — from a
      // single query. Matches the pattern api/funnels/analytics.ts already uses.
      supabase.from('funnel_leads').select('funnel_id, status, close_amount').in('funnel_id', funnelIds),
      // Real bookings, NOT funnel_events 'booked' rows — see lib/funnelAggregates
      // for why that event overcounts (a second writer with no calendar booking
      // behind it).
      supabase.from('bookings').select('funnel_id').in('funnel_id', funnelIds),
      // COACH-FACING LIST OF CALLS, so it is owned two ways — see
      // lib/coachBookings.ts. Scoped on funnel_id alone this panel silently
      // omitted every booking made through the coach's own /book/:slug page,
      // exactly as GET /api/calendar did. The two counts above stay
      // funnel-scoped on purpose: they are funnel analytics, and a call that
      // came through no funnel is not a data point about one.
      loadOwnedActiveBookings<UpcomingRow>({ userId, funnelIds, columns: UPCOMING_COLUMNS, refine: upcomingRefine(nowIso) }),
      supabase
        .from('funnel_leads')
        .select('id, funnel_id, first_name, email, opted_in_at, status')
        .in('funnel_id', funnelIds)
        .order('opted_in_at', { ascending: false })
        .limit(RECENT_LEADS_LIMIT),
    ])
    if (eventsRes.error) throw eventsRes.error
    if (leadsRes.error) throw leadsRes.error
    if (bookingsRes.error) throw bookingsRes.error
    if (recentLeadsRes.error) throw recentLeadsRes.error

    const buckets = new Map<string, FunnelBucket>()
    for (const id of funnelIds) buckets.set(id, emptyBucket())

    for (const row of (eventsRes.data || []) as { funnel_id: string }[]) {
      const b = buckets.get(row.funnel_id)
      if (b) b.visitors += 1
    }

    let leadsTotal = 0
    let closedTotal = 0
    let revenueTotal = 0
    for (const row of (leadsRes.data || []) as { funnel_id: string; status: string | null; close_amount: unknown }[]) {
      const b = buckets.get(row.funnel_id)
      leadsTotal += 1
      if (b) b.opt_ins += 1
      if (row.status === 'sold' || row.status === 'closed') {
        closedTotal += 1
        const amount = Number(row.close_amount) || 0
        revenueTotal += amount
        if (b) {
          b.closed += 1
          b.revenue += amount
        }
      }
    }

    let bookedTotal = 0
    for (const row of (bookingsRes.data || []) as { funnel_id: string | null }[]) {
      if (!row.funnel_id) continue // legacy shared-calendar bookings carry no funnel_id
      bookedTotal += 1
      const b = buckets.get(row.funnel_id)
      if (b) b.booked += 1
    }

    const visitorsTotal = (eventsRes.data || []).length

    const funnelsOut = funnels.map((f) => {
      const id = f.id as string
      const b = buckets.get(id) || emptyBucket()
      return {
        id,
        name: funnelDisplayName(f),
        // Draft funnels commonly have no subdomain yet (none claimed); '' keeps
        // this a string per the contract rather than null, and a public link
        // would go nowhere for a not-yet-live funnel anyway.
        slug: typeof f.subdomain === 'string' ? f.subdomain : '',
        // WHERE THIS FUNNEL LIVES, composed by lib/funnelDomain.ts. `slug` is
        // deliberately '' for a funnel with no subdomain and public_url is
        // deliberately null for the same funnel — they are different questions.
        // '' is a slug that has not been chosen; null is an address that does
        // not exist, and only the second one is safe to put in an href.
        public_url: funnelPublicUrl(f.subdomain as string | null | undefined),
        status: f.status === 'live' ? 'live' : 'draft',
        flow: { visitors: b.visitors, opt_ins: b.opt_ins, booked: b.booked },
        conversions: {
          visitors_to_optin: ratio(b.opt_ins, b.visitors),
          optin_to_booked: ratio(b.booked, b.opt_ins),
        },
      }
    })

    const upcoming_calls = (upcomingRows || []).map(
      toUpcoming
    )

    const recent_leads = (
      (recentLeadsRes.data || []) as {
        id: string
        funnel_id: string
        first_name: string | null
        email: string
        opted_in_at: string
        status: string
      }[]
    ).map((row) => ({
      lead_id: row.id,
      funnel_id: row.funnel_id,
      name: row.first_name,
      email: row.email,
      opted_in_at: row.opted_in_at,
      status: row.status,
    }))

    return res.status(200).json({
      totals: {
        visitors: visitorsTotal,
        leads: leadsTotal,
        calls_booked: bookedTotal,
        // 0..1 ratio (see the `ratio()` comment) — multiply by 100 for a percent.
        booked_rate: ratio(bookedTotal, leadsTotal),
        closed: closedTotal,
        revenue: revenueTotal,
      },
      funnels: funnelsOut,
      upcoming_calls,
      recent_leads,
      // The bare apex, for a live preview under a subdomain field before any
      // funnel exists to have a public_url. Beside the list, not inside a row:
      // it is a property of the deployment, not of a funnel.
      funnel_domain: FUNNEL_PUBLIC_DOMAIN,
    })
  } catch (err) {
    console.error('[funnels/portfolio] GET', err)
    return res.status(500).json({ error: 'Failed to load portfolio' })
  }
}
