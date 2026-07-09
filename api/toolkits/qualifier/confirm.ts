import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { QualifierDeck } from '../../../lib/qualifierAnalysis'
import { getValidatedBlueprint, saveByCardIdEntry } from '../../../lib/toolkitsShared'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// Explicit buy-in step for one card_id's qualifier. Body carries card_id plus
// the full (possibly edited) deck. Re-verifies the card is still a validated
// blueprint belonging to this user before writing. Sets confirmed: true.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { coach_name, system_prompt, deployment_instructions } = body

  const valid = isNonEmptyString(coach_name) && isNonEmptyString(system_prompt) && typeof deployment_instructions === 'string'

  if (!valid) {
    return res.status(400).json({
      error: 'Invalid confirm payload — expects card_id, coach_name/system_prompt (non-empty strings), and deployment_instructions (string)',
    })
  }

  try {
    const blueprintGate = await getValidatedBlueprint(userId, body.card_id)
    if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

    const sync_snapshot = await stampSyncSnapshot(userId, 'qualifier', blueprintGate.card.id)

    const updated: QualifierDeck = {
      coach_name,
      system_prompt,
      deployment_instructions,
      confirmed: true,
      sync_snapshot,
    }

    const saved = await saveByCardIdEntry(userId, 'qualifier', blueprintGate.card.id, updated)

    return res.status(200).json(saved.by_card_id[blueprintGate.card.id])
  } catch (err) {
    console.error('[toolkits/qualifier/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
