import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const DEFAULT_SETTINGS = {
  email_notifications: true,
  product_updates: true,
  theme: 'system' as const,
  preferences: {} as Record<string, unknown>,
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  // GET — return the user's settings, falling back to defaults
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('user_settings')
        .select('email_notifications, product_updates, theme, preferences')
        .eq('user_id', payload.userId)
        .maybeSingle()

      if (error) throw error

      return res.status(200).json({ settings: data || DEFAULT_SETTINGS })
    } catch (err) {
      console.error('[settings] GET', err)
      return res.status(500).json({ error: 'Failed to load settings' })
    }
  }

  // POST — upsert the user's settings
  if (req.method === 'POST') {
    const { email_notifications, product_updates, theme, preferences } = req.body || {}

    const updates: Record<string, unknown> = { user_id: payload.userId }

    if (email_notifications !== undefined) {
      if (typeof email_notifications !== 'boolean') {
        return res.status(400).json({ error: 'email_notifications must be a boolean' })
      }
      updates.email_notifications = email_notifications
    }

    if (product_updates !== undefined) {
      if (typeof product_updates !== 'boolean') {
        return res.status(400).json({ error: 'product_updates must be a boolean' })
      }
      updates.product_updates = product_updates
    }

    if (theme !== undefined) {
      if (!['light', 'dark', 'system'].includes(theme)) {
        return res.status(400).json({ error: "theme must be 'light', 'dark', or 'system'" })
      }
      updates.theme = theme
    }

    if (preferences !== undefined) {
      if (typeof preferences !== 'object' || preferences === null || Array.isArray(preferences)) {
        return res.status(400).json({ error: 'preferences must be an object' })
      }
      updates.preferences = preferences
    }

    try {
      const { data, error } = await supabase
        .from('user_settings')
        .upsert(updates, { onConflict: 'user_id' })
        .select('email_notifications, product_updates, theme, preferences')
        .single()

      if (error) throw error

      return res.status(200).json({ ok: true, settings: data })
    } catch (err) {
      console.error('[settings] POST', err)
      return res.status(500).json({ error: 'Failed to save settings' })
    }
  }

  return res.status(405).end()
}
