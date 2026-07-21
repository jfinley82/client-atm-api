import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../lib/supabase'
import { setCors, noStore } from '../lib/cors'
import { requireFunnelBuilder } from '../lib/funnels'
import { loadBusinessSettings, validateBusinessSettingsInput } from '../lib/businessSettings'

// GET/PATCH /api/funnel-business-settings — the coach's ACCOUNT-LEVEL funnel
// business settings (brand identity, tracking pixels, meeting room, legal),
// keyed on the authenticated user. Reused across all their funnels. Authed
// (requireFunnelBuilder). PATCH is partial + accepts the { settings } envelope.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    noStore(res)
    try {
      const settings = await loadBusinessSettings(userId)
      return res.status(200).json({ settings })
    } catch (err) {
      console.error('[funnel-business-settings] GET', err)
      return res.status(500).json({ error: 'Failed to load business settings' })
    }
  }

  if (req.method === 'PATCH') {
    const parsed = validateBusinessSettingsInput(req.body)
    if (!parsed.ok) {
      return res.status(400).json({ error: 'invalid_field', field: parsed.field })
    }
    try {
      const { error } = await supabase
        .from('funnel_business_settings')
        .upsert({ user_id: userId, ...parsed.update, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      if (error) throw error
      const settings = await loadBusinessSettings(userId)
      return res.status(200).json({ settings })
    } catch (err) {
      console.error('[funnel-business-settings] PATCH', err)
      return res.status(500).json({ error: 'Failed to save business settings' })
    }
  }

  return res.status(405).end()
}
