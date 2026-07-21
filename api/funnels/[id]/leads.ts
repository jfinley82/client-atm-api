import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'

// GET /api/funnels/[id]/leads — the funnel's captured leads, owner-scoped,
// newest first. Read-only CRM list.
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
    const { data, error } = await supabase
      .from('funnel_leads')
      .select('id, first_name, email, phone, status, close_amount, notes, opted_in_at, created_at')
      .eq('funnel_id', id)
      .order('created_at', { ascending: false })

    if (error) throw error
    return res.status(200).json({ leads: data || [] })
  } catch (err) {
    console.error('[funnels/[id]/leads] GET', err)
    return res.status(500).json({ error: 'Failed to load leads' })
  }
}
