import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // POST — save a completed matcher output as a new problem/solution card
  if (req.method === 'POST') {
    const {
      card_name,
      surface_problem,
      real_problem,
      urgency,
      tried_before,
      your_solution,
      transformation,
      natural_bridge,
      hook_angle,
      training_title,
      validated,
    } = req.body || {}

    if (!card_name || typeof card_name !== 'string') {
      return res.status(400).json({ error: 'card_name required' })
    }

    try {
      const { data, error } = await supabase
        .from('problem_solution_cards')
        .insert({
          user_id: userId,
          card_name,
          surface_problem: surface_problem ?? null,
          real_problem: real_problem ?? null,
          urgency: urgency ?? null,
          tried_before: tried_before ?? [],
          your_solution: your_solution ?? null,
          transformation: transformation ?? null,
          natural_bridge: natural_bridge ?? null,
          hook_angle: hook_angle ?? null,
          training_title: training_title ?? null,
          validated: validated ?? false,
        })
        .select()
        .single()

      if (error) throw error
      return res.status(200).json(data)
    } catch (err) {
      console.error('[cards] POST', err)
      return res.status(500).json({ error: 'Failed to save card' })
    }
  }

  // GET — list all cards for the authenticated user
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('problem_solution_cards')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return res.status(200).json(data || [])
    } catch (err) {
      console.error('[cards] GET', err)
      return res.status(500).json({ error: 'Failed to load cards' })
    }
  }

  // DELETE — delete a card by id (must belong to the user)
  if (req.method === 'DELETE') {
    const rawId = (req.body && req.body.id) ?? (req.query && req.query.id)
    const id = Array.isArray(rawId) ? rawId[0] : rawId
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id required' })
    }

    try {
      const { data: card } = await supabase
        .from('problem_solution_cards')
        .select('id, user_id')
        .eq('id', id)
        .single()

      if (!card || card.user_id !== userId) {
        return res.status(404).json({ error: 'Card not found' })
      }

      const { error } = await supabase
        .from('problem_solution_cards')
        .delete()
        .eq('id', id)

      if (error) throw error
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[cards] DELETE', err)
      return res.status(500).json({ error: 'Failed to delete card' })
    }
  }

  return res.status(405).end()
}
