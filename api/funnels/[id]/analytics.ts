import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'
import { computePeriodWindows, normalizePeriod, pctDelta, Window } from '../../../lib/analyticsPeriod'

// GET /api/funnels/[id]/analytics?period=month — owner-scoped funnel metrics from
// funnel_events + funnel_leads. Returns:
//  - all-time KPIs (back-compat): visits, leads, appointments, rates
//  - revenue rollup: totals { closed_count, total_revenue, avg_deal }, close_rate
//  - period comparison: current / previous / delta_pct per KPI (powers the
//    "+15% vs last month" cards). period ∈ month|week|7d|30d|90d (default month).
// No video metrics (Phase 4).

// Count funnel_events of a type in [start,end) — head:true, count only.
async function countEvents(funnelId: string, eventType: string, w?: Window): Promise<number> {
  let q = supabase
    .from('funnel_events')
    .select('*', { count: 'exact', head: true })
    .eq('funnel_id', funnelId)
    .eq('event_type', eventType)
  if (w) q = q.gte('created_at', w.start).lt('created_at', w.end)
  const { count } = await q
  return count ?? 0
}

// Count leads captured in [start,end) by opted_in_at (all-time when w omitted).
async function countLeads(funnelId: string, w?: Window): Promise<number> {
  let q = supabase.from('funnel_leads').select('*', { count: 'exact', head: true }).eq('funnel_id', funnelId)
  if (w) q = q.gte('opted_in_at', w.start).lt('opted_in_at', w.end)
  const { count } = await q
  return count ?? 0
}

// Real appointment count: rows in `bookings`, not `funnel_events` rows tagged
// 'booked'. That event has a SECOND writer — api/funnels/[id]/leads/[leadId].ts
// logs one whenever a coach manually moves a lead's CRM status to "booked",
// which requires no calendar booking to exist at all. That log is correct for
// its own purpose (the lead's engagement timeline needs a timestamped record of
// the status change), but counting it here inflated "appointments"/chain.booked
// above the funnel's real booking count — e.g. 3 events for 2 actual bookings.
// bookings.status is only ever 'active' or 'canceled' (migration 031); both
// count here, deliberately unfiltered by status: a canceled booking still WAS a
// real appointment at the moment it was made, the same fact the old 'booked'
// event recorded permanently regardless of what happened afterward. Windowed by
// created_at as the events version was, so a period comparison still means "how
// many calls got booked in this window."
async function countBookings(funnelId: string, w?: Window): Promise<number> {
  let q = supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('funnel_id', funnelId)
  if (w) q = q.gte('created_at', w.start).lt('created_at', w.end)
  const { count } = await q
  return count ?? 0
}

// Distinct PEOPLE who produced an event, not raw event rows. An anonymous event
// (lead_id null) is its own person, since there is nothing to dedupe it against.
// Used for the funnel chain, where a lead who re-submits an application must not
// widen the step above the one below it and make the chain read as if it grew.
async function countDistinctLeadEvents(funnelId: string, eventType: string): Promise<number> {
  const { data } = await supabase
    .from('funnel_events')
    .select('lead_id')
    .eq('funnel_id', funnelId)
    .eq('event_type', eventType)
  const rows = (data as { lead_id: string | null }[]) || []
  const named = new Set(rows.map((r) => r.lead_id).filter((x): x is string => !!x))
  const anonymous = rows.filter((r) => !r.lead_id).length
  return named.size + anonymous
}

type WindowKpis = { visits: number; leads: number; appointments: number; closed: number; revenue: number }

// Windowed KPIs. closed + revenue come from WON engagement events (sold/closed)
// in the window (so they have a timestamp) → the distinct leads → their
// close_amount. Deduped by lead, so a lead with both events counts once.
async function windowKpis(funnelId: string, w: Window): Promise<WindowKpis> {
  const [visits, appointments, leads, closedEvents] = await Promise.all([
    countEvents(funnelId, 'landing_view', w),
    countBookings(funnelId, w),
    countLeads(funnelId, w),
    supabase
      .from('funnel_events')
      .select('lead_id')
      .eq('funnel_id', funnelId)
      .in('event_type', ['sold', 'closed'])
      .gte('created_at', w.start)
      .lt('created_at', w.end),
  ])

  const leadIds = [...new Set(((closedEvents.data as { lead_id: string | null }[]) || []).map((e) => e.lead_id).filter((x): x is string => !!x))]
  let revenue = 0
  if (leadIds.length) {
    const { data } = await supabase.from('funnel_leads').select('close_amount').eq('funnel_id', funnelId).in('id', leadIds)
    revenue = (data || []).reduce((s, r) => s + (Number((r as { close_amount: unknown }).close_amount) || 0), 0)
  }
  return { visits, leads, appointments, closed: leadIds.length, revenue }
}

// Upcoming calls for this funnel's dashboard panel. Active bookings from now
// forward, soonest first. Sourced from bookings.funnel_id (added in migration
// 062) — before that column existed there was no funnel-scoped source at all,
// which is why the panel read empty while the KPI counted the booking from
// funnel_events.
//
// Capped: the panel is a "what's next" list, not a calendar. A coach with a full
// pipeline does not need every future call serialized into the dashboard payload.
const UPCOMING_CALLS_LIMIT = 25

async function loadUpcomingCalls(funnelId: string) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, name, email, start_time, end_time, zoom_join_url, meeting_url')
    .eq('funnel_id', funnelId)
    .eq('status', 'active')
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(UPCOMING_CALLS_LIMIT)
  if (error) throw error
  return (data || []).map((b: any) => ({
    id: b.id,
    name: b.name,
    email: b.email,
    start_time: b.start_time,
    end_time: b.end_time,
    // Google-path bookings store the link in meeting_url, Zoom-path in
    // zoom_join_url. The panel wants one field, so surface whichever exists
    // under the documented name rather than making the frontend know the split.
    zoom_join_url: b.zoom_join_url || b.meeting_url || null,
  }))
}

// The conversion chain, which is a different chain depending on what the funnel
// is FOR. Reporting "booked" on a funnel that sells straight off the training
// page would show a permanent zero and read as a broken funnel; reporting
// "offer clicks" on a booking funnel is equally meaningless.
//
//   book: visits -> opt-ins -> applied -> qualified -> booked -> closed
//   sell: visits -> opt-ins -> offer clicks -> sales (+ revenue)
//
// The application steps only appear when the gate is actually on. A booking
// funnel without it goes straight from opt-ins to booked, which is what really
// happens there.
type ChainStep = { key: string; label: string; count: number }

async function buildChain(
  funnelId: string,
  funnel: Record<string, any>,
  visits: number,
  leads: number,
  appointments: number,
  closedCount: number,
  totalRevenue: number
): Promise<{ mode: 'book' | 'sell'; steps: ChainStep[]; revenue?: number }> {
  const head: ChainStep[] = [
    { key: 'visits', label: 'Visits', count: visits },
    { key: 'opt_ins', label: 'Opt-ins', count: leads },
  ]

  if (funnel.cta_mode === 'sell') {
    const [offerClicks, sales] = await Promise.all([
      countDistinctLeadEvents(funnelId, 'offer_click'),
      countEvents(funnelId, 'sold'),
    ])
    return {
      mode: 'sell',
      steps: [...head, { key: 'offer_clicks', label: 'Offer clicks', count: offerClicks }, { key: 'sales', label: 'Sales', count: sales }],
      revenue: totalRevenue,
    }
  }

  const gated = funnel.application_questions_enabled === true
  const [applied, qualified] = gated
    ? await Promise.all([
        countDistinctLeadEvents(funnelId, 'application_submitted'),
        countDistinctLeadEvents(funnelId, 'qualified'),
      ])
    : [0, 0]

  return {
    mode: 'book',
    steps: [
      ...head,
      ...(gated
        ? [
            { key: 'applied', label: 'Applied', count: applied },
            { key: 'qualified', label: 'Qualified', count: qualified },
          ]
        : []),
      { key: 'booked', label: 'Booked', count: appointments },
      { key: 'closed', label: 'Closed', count: closedCount },
    ],
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // The two columns buildChain branches on must be SELECTED — getOwnedFunnel
  // defaults to 'id, user_id', which would leave both undefined and silently
  // report every funnel as an ungated booking funnel.
  const funnel = await getOwnedFunnel(userId, id, 'id, user_id, cta_mode, application_questions_enabled')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const period = normalizePeriod(Array.isArray(req.query.period) ? req.query.period[0] : req.query.period)
  const windows = computePeriodWindows(period, Date.now())

  try {
    const [visits, appointments, leads, closedRows, current, previous, upcoming_calls] = await Promise.all([
      countEvents(id, 'landing_view'),
      countBookings(id),
      countLeads(id),
      // All-time revenue rollup — sum of close_amount over WON leads (sold or
      // closed). A lead only ever holds one status, so no double-count.
      supabase.from('funnel_leads').select('close_amount').eq('funnel_id', id).in('status', ['sold', 'closed']),
      windowKpis(id, windows.current),
      windowKpis(id, windows.previous),
      loadUpcomingCalls(id),
    ])

    const closedAmounts = (closedRows.data || []).map((r) => Number((r as { close_amount: unknown }).close_amount) || 0)
    const closed_count = closedAmounts.length
    const total_revenue = closedAmounts.reduce((s, n) => s + n, 0)
    const avg_deal = closed_count > 0 ? Math.round((total_revenue / closed_count) * 100) / 100 : 0

    const chain = await buildChain(id, funnel, visits, leads, appointments, closed_count, total_revenue)

    const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0)

    const delta_pct = {
      visits: pctDelta(current.visits, previous.visits),
      leads: pctDelta(current.leads, previous.leads),
      appointments: pctDelta(current.appointments, previous.appointments),
      closed: pctDelta(current.closed, previous.closed),
      revenue: pctDelta(current.revenue, previous.revenue),
    }

    return res.status(200).json({
      // all-time (back-compat)
      visits,
      leads,
      appointments,
      rates: {
        lead_rate: ratio(leads, visits),
        appointment_rate: ratio(appointments, leads),
        close_rate: ratio(closed_count, leads),
      },
      totals: { closed_count, total_revenue, avg_deal },
      // Mode-adaptive conversion chain — book vs sell. See buildChain.
      chain,
      // Upcoming Calls panel — active future bookings for this funnel.
      upcoming_calls,
      // period-over-period
      period,
      window: windows,
      current,
      previous,
      delta_pct,
    })
  } catch (err) {
    console.error('[funnels/[id]/analytics] GET', err)
    return res.status(500).json({ error: 'Failed to load analytics' })
  }
}
