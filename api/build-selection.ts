import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../lib/auth'
import { setCors, noStore } from '../lib/cors'
import { getSavedOutput, saveOutput } from '../lib/savedOutputs'
import { getValidatedBlueprint } from '../lib/toolkitsShared'

// Step 4 (Build) blueprint selection. A coach reviews their Framework +
// Blueprints and selects ONE blueprint before Build unlocks (the review screen
// is a later frontend phase). This persists that selection.
//
// Storage: saved_outputs tool_type 'build_selection', content { card_id,
// selected_at }. One active selection per user (upsert on user_id,tool_type),
// so re-selecting overwrites.
//
// GET  -> { card_id: <selected> | null }
// POST { card_id } -> validates the card is a validated, user-owned blueprint,
//                     persists the selection, returns { card_id }.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    noStore(res)
    try {
      const saved = await getSavedOutput(userId, 'build_selection')
      const cardId = (saved?.content as { card_id?: unknown } | undefined)?.card_id
      return res.status(200).json({ card_id: typeof cardId === 'string' ? cardId : null })
    } catch (err) {
      console.error('[build-selection] GET', err)
      return res.status(500).json({ error: 'Failed to load build selection' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  try {
    // Only a validated, user-owned blueprint can be selected (same precise
    // by-id check the toolkits use — never trust a client-supplied card_id).
    const gate = await getValidatedBlueprint(userId, body.card_id)
    if (!gate.ok) return res.status(400).json({ error: gate.error })

    await saveOutput(userId, 'build_selection', { card_id: gate.card.id, selected_at: new Date().toISOString() })

    return res.status(200).json({ card_id: gate.card.id })
  } catch (err) {
    console.error('[build-selection] POST', err)
    return res.status(500).json({ error: 'Failed to save build selection' })
  }
}
