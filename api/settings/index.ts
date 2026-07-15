// Run this SQL manually in Supabase before using this endpoint:
// create table if not exists app_settings (
//   key text primary key,
//   value text,
//   updated_at timestamptz default now()
// );
// insert into app_settings (key, value) values
//   ('training_video_url', ''),
//   ('replay_video_url', ''),
//   ('login_headline', ''),
//   ('workshop_event_date', '')
// on conflict (key) do nothing;

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { ALLOWED_SETTING_KEYS } from '../../lib/appSettings'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  // GET — public: return all settings as a flat object
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('key, value')

      if (error) throw error

      const settings: Record<string, string> = {}
      for (const row of data || []) {
        settings[row.key] = row.value
      }

      return res.status(200).json(settings)
    } catch (err) {
      console.error('[settings] GET', err)
      return res.status(500).json({ error: 'Failed to load settings' })
    }
  }

  // POST — admin only: upsert a single setting
  if (req.method === 'POST') {
    const userId = await requireActiveUser(req, res)
    if (!userId) return

    const { data: actingUser } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single()

    if (!actingUser || actingUser.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const { key, value } = req.body || {}

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'key required' })
    }
    // Same allowlist as PATCH /api/admin/settings — a stray form field must
    // fail loudly, not silently upsert an orphan key nothing reads.
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      return res.status(400).json({ error: `unknown setting '${key}'` })
    }
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' })
    }

    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert(
          { key, value, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        )

      if (error) throw error

      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[settings] POST', err)
      return res.status(500).json({ error: 'Failed to save setting' })
    }
  }

  return res.status(405).end()
}
