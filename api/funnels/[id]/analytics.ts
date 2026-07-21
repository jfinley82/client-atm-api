import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'

// GET /api/funnels/[id]/analytics — owner-scoped funnel funnel-metrics from
// funnel_events + funnel_leads. Raw counts + conversion rates only; no video
// metrics (that's a later phase).
//
// visits       = landing_view events
// leads        = funnel_leads rows (the captured leads; equals signup events)
// appointments = booked events
// rates        = { lead_rate: leads/visits, appointment_rate: appointments/leads }
//                each a 0..1 ratio, 0 when the denominator is 0.
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

  try {
    // head:true count queries — we only need the counts, not the rows.
    const [visitsRes, apptsRes, leadsRes] = await Promise.all([
      supabase
        .from('funnel_events')
        .select('*', { count: 'exact', head: true })
        .eq('funnel_id', id)
        .eq('event_type', 'landing_view'),
      supabase
        .from('funnel_events')
        .select('*', { count: 'exact', head: true })
        .eq('funnel_id', id)
        .eq('event_type', 'booked'),
      supabase.from('funnel_leads').select('*', { count: 'exact', head: true }).eq('funnel_id', id),
    ])

    if (visitsRes.error) throw visitsRes.error
    if (apptsRes.error) throw apptsRes.error
    if (leadsRes.error) throw leadsRes.error

    const visits = visitsRes.count ?? 0
    const appointments = apptsRes.count ?? 0
    const leads = leadsRes.count ?? 0

    // 4-decimal ratios; 0 when the denominator is 0 (avoid divide-by-zero).
    const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : 0)

    return res.status(200).json({
      visits,
      leads,
      appointments,
      rates: {
        lead_rate: ratio(leads, visits),
        appointment_rate: ratio(appointments, leads),
      },
    })
  } catch (err) {
    console.error('[funnels/[id]/analytics] GET', err)
    return res.status(500).json({ error: 'Failed to load analytics' })
  }
}
