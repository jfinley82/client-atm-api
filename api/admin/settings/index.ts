import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'

// app_settings is a key/value table (key text PK, value text, updated_at). GET
// returns the settings as a flat object; PATCH accepts a flat object of
// key -> value pairs and upserts each key.
async function loadSettings(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('app_settings').select('key, value')
  if (error) throw error
  const settings: Record<string, string> = {}
  for (const row of data || []) settings[row.key] = row.value
  return settings
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

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

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ settings: await loadSettings() })
    } catch (err) {
      console.error('[admin/settings] GET', err)
      return res.status(500).json({ error: 'Failed to load settings' })
    }
  }

  if (req.method === 'PATCH') {
    const body = req.body || {}
    const keys = Object.keys(body)
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Provide at least one setting to update' })
    }
    for (const key of keys) {
      if (typeof body[key] !== 'string') {
        return res.status(400).json({ error: `value for '${key}' must be a string` })
      }
    }

    try {
      const now = new Date().toISOString()
      const rows = keys.map((key) => ({ key, value: body[key] as string, updated_at: now }))

      const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' })
      if (error) throw error

      return res.status(200).json({ settings: await loadSettings() })
    } catch (err) {
      console.error('[admin/settings] PATCH', err)
      return res.status(500).json({ error: 'Failed to update settings' })
    }
  }

  return res.status(405).end()
}
