import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // Confirm ownership before publishing (404 rather than leak existence)
  const { data: funnel, error: loadError } = await supabase
    .from('funnels')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle()

  if (loadError) {
    console.error('[funnels/[id]/publish] load', loadError)
    return res.status(500).json({ error: 'Failed to load funnel' })
  }
  if (!funnel || funnel.user_id !== userId) {
    return res.status(404).json({ error: 'Funnel not found' })
  }

  // Phase 0: no additional validation. Later phases add checks (e.g. video uploaded).
  try {
    const { data, error } = await supabase
      .from('funnels')
      .update({ status: 'live', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) throw error
    return res.status(200).json({ funnel: data })
  } catch (err) {
    console.error('[funnels/[id]/publish] POST', err)
    return res.status(500).json({ error: 'Failed to publish funnel' })
  }
}
