import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  try {
    const { data, error } = await supabase
      .from('unlock_schedule')
      .select('item_key, unlock_at')
      .order('item_key', { ascending: true })

    if (error) throw error

    const schedule: Record<string, string | null> = {}
    for (const row of data || []) {
      schedule[row.item_key] = row.unlock_at
    }

    return res.status(200).json({ schedule })
  } catch (err) {
    console.error('[schedule]', err)
    return res.status(500).json({ error: 'Failed to load schedule' })
  }
}
