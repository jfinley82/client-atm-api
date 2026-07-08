import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// Read-only list of the caller's own validated Micro-Blueprints, for the
// Toolkits UI's Slides/Qualifier card_id selectors. /api/cards (the old
// read+write endpoint) was deprecated to 410 Gone for every method earlier
// tonight — this does NOT resurrect it or any of its write behavior; GET
// only, no insert/update/delete path exists here. Not tier-gated: this is a
// plain read of already-existing rows, no AI generation involved, matching
// the convention of every other GET in this app (e.g. matcher/analyze.ts,
// core-offers/analyze.ts) — only the POST/generation calls check
// membership_tier.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { data, error } = await supabase
      .from('problem_solution_cards')
      .select('id, card_name, problem_text, suggested_offer')
      .eq('user_id', userId)
      .eq('validated', true)
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json(data || [])
  } catch (err) {
    console.error('[matcher/cards] GET', err)
    return res.status(500).json({ error: 'Failed to load cards' })
  }
}
