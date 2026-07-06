import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors } from '../../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../../lib/savedOutputs'
import { FrameworkAnalysis, resolveFrameworkName } from '../../../../lib/frameworkAnalysis'

// Swap which of the 3 name options is active. Lightweight — no Anthropic call,
// so auth-gated only, not tier-gated (same as Transform's /select). The
// phases/steps/copy are unchanged; only frameworkName/frameworkTagline are
// re-resolved from the newly selected option. Re-selecting resets confirmed to
// false — a new selection is a draft under review again until re-confirmed.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const selectedNameId = body.selected_name_id

  if (typeof selectedNameId !== 'string' || selectedNameId.trim().length === 0) {
    return res.status(400).json({ error: 'selected_name_id required' })
  }

  try {
    const frameworkRow = await getSavedOutput(userId, 'framework')
    if (!frameworkRow) return res.status(404).json({ error: 'No framework generated yet' })

    const framework = frameworkRow.content as FrameworkAnalysis
    const exists = framework.name_options.some((o) => o.id === selectedNameId)
    if (!exists) {
      return res.status(400).json({ error: `Unknown name option id: ${selectedNameId}` })
    }

    const { frameworkName, frameworkTagline } = resolveFrameworkName(framework.name_options, selectedNameId)

    const updated: FrameworkAnalysis = {
      ...framework,
      frameworkName,
      frameworkTagline,
      selected_name_id: selectedNameId,
      confirmed: false,
    }

    await saveOutput(userId, 'framework', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[transformation/framework/select] POST', err)
    return res.status(500).json({ error: 'Selection failed' })
  }
}
