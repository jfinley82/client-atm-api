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
      // `reason` distinguishes WHY a slug was refused (too short, reserved,
      // malformed) so the Profile Settings field can say which, rather than
      // showing one generic message for five different mistakes.
      return res.status(400).json({ error: 'invalid_field', field: parsed.field, ...(parsed.reason ? { reason: parsed.reason } : {}) })
    }
    try {
      const update = { ...parsed.update }
      // notification_prefs is a partial patch (validateBusinessSettingsInput
      // only validates the keys given), but the column itself is a single jsonb
      // value with no DB-level merge — writing the partial straight through
      // would silently reset any pref not included back to nothing. Merge onto
      // the coach's current stored prefs first, unlike tracking/legal below
      // which are intentionally full-replace.
      if ('notification_prefs' in update) {
        const current = await loadBusinessSettings(userId)
        update.notification_prefs = { ...current.notification_prefs, ...(update.notification_prefs as object) }
      }
      const { error } = await supabase
        .from('funnel_business_settings')
        .upsert({ user_id: userId, ...update, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      // A taken booking_slug is a normal outcome of a coach choosing an
      // address, not a server fault. The unique index is the authority — a
      // read-then-write check would still race two coaches claiming the same
      // slug at once — so the 23505 is caught here and named.
      if (error && (error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'slug_taken', field: 'booking_slug' })
      }
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
