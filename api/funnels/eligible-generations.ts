import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'

// GET /api/funnels/eligible-generations — the chooser feed for "create a funnel
// from a finished Micro-Training". Lists the user's COMPLETED generations (a
// generation counts as complete once its slides are built), joined to their
// blueprint label, most recent first.
//
// Returns { generations: [{ id, title, blueprint_label, created_at }] }, where
// title is the generation's chosen_topic and blueprint_label is the
// problem_solution_cards.card_name it was built from.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  try {
    const { data, error } = await supabase
      .from('mtm_generations')
      .select('id, card_id, chosen_topic, slides, created_at, problem_solution_cards(card_name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    const generations = (data || [])
      // Complete = slides present (mirrors buildReady in my-micro-trainings).
      .filter((g: any) => Array.isArray(g.slides) && g.slides.length > 0)
      .map((g: any) => {
        // Supabase returns the embedded row as an object or a single-element
        // array depending on the relationship; handle both.
        const card = Array.isArray(g.problem_solution_cards) ? g.problem_solution_cards[0] : g.problem_solution_cards
        return {
          id: g.id,
          title: typeof g.chosen_topic === 'string' && g.chosen_topic.trim() ? g.chosen_topic.trim() : null,
          blueprint_label: card?.card_name ?? null,
          created_at: g.created_at,
        }
      })

    return res.status(200).json({ generations })
  } catch (err) {
    console.error('[funnels/eligible-generations] GET', err)
    return res.status(500).json({ error: 'Failed to load eligible generations' })
  }
}
