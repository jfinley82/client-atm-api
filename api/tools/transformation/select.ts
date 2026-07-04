import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { TransformationAnalysis } from '../../../lib/transformationAnalysis'

// Pick which of the 3 generated candidates the member wants to build on.
// No Anthropic call happens here (unlike matcher/selection, which can
// regenerate a suggested_offer on swap), so this is auth-gated only, not
// tier-gated. Re-selecting resets confirmed to false — a new selection is a
// draft under review again until explicitly re-confirmed.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const selectedId = body.selected_id

  if (typeof selectedId !== 'string' || selectedId.trim().length === 0) {
    return res.status(400).json({ error: 'selected_id required' })
  }

  try {
    const analysisRow = await getSavedOutput(userId, 'transformation_analysis')
    if (!analysisRow) return res.status(404).json({ error: 'No analysis generated yet' })

    const analysis = analysisRow.content as TransformationAnalysis
    const exists = analysis.candidates.some((c) => c.id === selectedId)
    if (!exists) {
      return res.status(400).json({ error: `Unknown candidate id: ${selectedId}` })
    }

    const updated: TransformationAnalysis = {
      ...analysis,
      selected_id: selectedId,
      confirmed: false,
    }

    await saveOutput(userId, 'transformation_analysis', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[transformation/select] POST', err)
    return res.status(500).json({ error: 'Selection failed' })
  }
}
