import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { computePeriodWindows, normalizePeriod, pctDelta, Window } from '../../lib/analyticsPeriod'
import { countEventsAll, countLeadsAll, countBookingsAll } from '../../lib/funnelAggregates'

// GET /api/funnels/analytics?period=month — ALL-FUNNELS rollup for the Overview.
//
// Sibling to /api/funnels/[id]/analytics (which stays the per-funnel view) and to
// /api/funnels/portfolio (the portfolio-home shape). This exists rather than
// having the frontend sum the per-funnel endpoint because that would cost one
// HTTP round trip AND ~10 Supabase queries PER FUNNEL; this runs a fixed handful
// of queries for the whole set by filtering on `funnel_id in (...)`.
//
// Shape deliberately mirrors the per-funnel endpoint (visits/leads/appointments/
// rates/totals + current/previous/delta_pct) so the Overview card can reuse the
// same rendering as a single funnel's card, plus a per-funnel breakdown.
export const config = { maxDuration: 30 }

type Kpis = { visits: number; leads: number; appointments: number; closed: number; revenue: number }

const emptyKpis = (): Kpis => ({ visits: 0, leads: 0, appointments: 0, closed: 0, revenue: 0 })

// Windowed rollup. closed/revenue come from WON engagement events in the window
// (so they carry a timestamp) → distinct leads → their close_amount, deduped by
// lead so a lead with both 'sold' and 'closed' counts once. Same method as the
// per-funnel endpoint, widened to the whole set.
async function windowKpisAll(funnelIds: string[], w: Window): Promise<Kpis> {
  const [visits, appointments, leads, closedEvents] = await Promise.all([
    countEventsAll(funnelIds, 'landing_view', w),
    countBookingsAll(funnelIds, w),
    countLeadsAll(funnelIds, w),
    supabase
      .from('funnel_events')
      .select('lead_id')
      .in('funnel_id', funnelIds)
      .in('event_type', ['sold', 'closed'])
      .gte('created_at', w.start)
      .lt('created_at', w.end),
  ])

  const leadIds = [
    ...new Set(((closedEvents.data as { lead_id: string | null }[]) || []).map((e) => e.lead_id).filter((x): x is string => !!x)),
  ]
  let revenue = 0
  if (leadIds.length) {
    const { data } = await supabase.from('funnel_leads').select('close_amount').in('id', leadIds)
    revenue = (data || []).reduce((s, r) => s + (Number((r as { close_amount: unknown }).close_amount) || 0), 0)
  }
  return { visits, leads, appointments, closed: leadIds.length, revenue }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const period = normalizePeriod(Array.isArray(req.query.period) ? req.query.period[0] : req.query.period)
  const windows = computePeriodWindows(period, Date.now())
  const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0)

  try {
    // Ownership is enforced here, once: every later query is scoped to THIS
    // coach's funnel ids, so no per-funnel ownership check is needed downstream.
    const { data: funnelRows, error: funnelErr } = await supabase
      .from('funnels')
      .select('id, subdomain, status')
      .eq('user_id', userId)
    if (funnelErr) throw funnelErr

    const funnels = funnelRows || []
    const funnelIds = funnels.map((f) => f.id as string)

    // No funnels yet: return the same shape with zeros so the Overview renders
    // an empty state instead of the frontend special-casing a 404/empty body.
    if (funnelIds.length === 0) {
      return res.status(200).json({
        funnel_count: 0,
        visits: 0,
        leads: 0,
        appointments: 0,
        rates: { lead_rate: 0, appointment_rate: 0, close_rate: 0 },
        totals: { closed_count: 0, total_revenue: 0, avg_deal: 0 },
        period,
        window: windows,
        current: emptyKpis(),
        previous: emptyKpis(),
        delta_pct: { visits: 0, leads: 0, appointments: 0, closed: 0, revenue: 0 },
        per_funnel: [],
      })
    }

    const [visits, appointments, leads, closedRows, current, previous, leadsByFunnel] = await Promise.all([
      countEventsAll(funnelIds, 'landing_view'),
      countBookingsAll(funnelIds),
      countLeadsAll(funnelIds),
      // All-time revenue — sum of close_amount over WON leads. A lead holds one
      // status, so there is no double count.
      supabase.from('funnel_leads').select('close_amount').in('funnel_id', funnelIds).in('status', ['sold', 'closed']),
      windowKpisAll(funnelIds, windows.current),
      windowKpisAll(funnelIds, windows.previous),
      // Per-funnel lead/revenue split for the Overview's funnel list. Pulled in
      // one query and bucketed in memory rather than N queries.
      supabase.from('funnel_leads').select('funnel_id, status, close_amount').in('funnel_id', funnelIds),
    ])

    const closedAmounts = (closedRows.data || []).map((r) => Number((r as { close_amount: unknown }).close_amount) || 0)
    const closed_count = closedAmounts.length
    const total_revenue = closedAmounts.reduce((s, n) => s + n, 0)
    const avg_deal = closed_count > 0 ? Math.round((total_revenue / closed_count) * 100) / 100 : 0

    const perFunnel = new Map<string, { leads: number; booked: number; closed: number; revenue: number }>()
    for (const fid of funnelIds) perFunnel.set(fid, { leads: 0, booked: 0, closed: 0, revenue: 0 })
    for (const row of (leadsByFunnel.data || []) as { funnel_id: string; status: string; close_amount: unknown }[]) {
      const b = perFunnel.get(row.funnel_id)
      if (!b) continue
      b.leads += 1
      if (row.status === 'booked' || row.status === 'sold' || row.status === 'closed') b.booked += 1
      if (row.status === 'sold' || row.status === 'closed') {
        b.closed += 1
        b.revenue += Number(row.close_amount) || 0
      }
    }

    return res.status(200).json({
      funnel_count: funnels.length,
      // all-time rollup (mirrors the per-funnel endpoint's top-level shape)
      visits,
      leads,
      appointments,
      rates: {
        lead_rate: ratio(leads, visits),
        appointment_rate: ratio(appointments, leads),
        close_rate: ratio(closed_count, leads),
      },
      totals: { closed_count, total_revenue, avg_deal },
      // period-over-period
      period,
      window: windows,
      current,
      previous,
      delta_pct: {
        visits: pctDelta(current.visits, previous.visits),
        leads: pctDelta(current.leads, previous.leads),
        appointments: pctDelta(current.appointments, previous.appointments),
        closed: pctDelta(current.closed, previous.closed),
        revenue: pctDelta(current.revenue, previous.revenue),
      },
      per_funnel: funnels.map((f) => ({
        id: f.id,
        subdomain: f.subdomain,
        status: f.status,
        ...(perFunnel.get(f.id as string) || { leads: 0, booked: 0, closed: 0, revenue: 0 }),
      })),
    })
  } catch (err) {
    console.error('[funnels/analytics] GET', err)
    return res.status(500).json({ error: 'Failed to load funnel rollup' })
  }
}
