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

type WindowKpis = { visits: number; leads: number; appointments: number; closed: number; revenue: number }

// Windowed KPIs. closed + revenue come from WON engagement events (sold/closed)
// in the window (so they have a timestamp) → the distinct leads → their
// close_amount. Deduped by lead, so a lead with both events counts once.
async function windowKpis(funnelId: string, w: Window): Promise<WindowKpis> {
  const [visits, appointments, leads, closedEvents] = await Promise.all([
    countEvents(funnelId, 'landing_view', w),
    countEvents(funnelId, 'booked', w),
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const funnel = await getOwnedFunnel(userId, id)
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const period = normalizePeriod(Array.isArray(req.query.period) ? req.query.period[0] : req.query.period)
  const windows = computePeriodWindows(period, Date.now())

  try {
    const [visits, appointments, leads, closedRows, current, previous] = await Promise.all([
      countEvents(id, 'landing_view'),
      countEvents(id, 'booked'),
      countLeads(id),
      // All-time revenue rollup — sum of close_amount over WON leads (sold or
      // closed). A lead only ever holds one status, so no double-count.
      supabase.from('funnel_leads').select('close_amount').eq('funnel_id', id).in('status', ['sold', 'closed']),
      windowKpis(id, windows.current),
      windowKpis(id, windows.previous),
    ])

    const closedAmounts = (closedRows.data || []).map((r) => Number((r as { close_amount: unknown }).close_amount) || 0)
    const closed_count = closedAmounts.length
    const total_revenue = closedAmounts.reduce((s, n) => s + n, 0)
    const avg_deal = closed_count > 0 ? Math.round((total_revenue / closed_count) * 100) / 100 : 0

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
