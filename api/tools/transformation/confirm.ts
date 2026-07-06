import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { TransformationAnalysis, TransformationCandidate } from '../../../lib/transformationAnalysis'

function hasStringFields(v: unknown, keys: string[]): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return keys.every((k) => typeof o[k] === 'string')
}

function isValidCandidate(v: unknown): v is TransformationCandidate {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.problem === 'string' &&
    typeof c.outcome === 'string' &&
    typeof c.whySelected === 'string' &&
    hasStringFields(c.beforeState, ['beliefs', 'internalTalk', 'results']) &&
    hasStringFields(c.afterState, ['beliefs', 'internalTalk', 'results']) &&
    hasStringFields(c.rootCause, ['corePattern', 'sustainingBelief', 'emotionalProtection', 'skillVsIdentity']) &&
    hasStringFields(c.rootDesire, ['surfaceDesire', 'emotionalDesire', 'identityShift', 'lifestyleShift']) &&
    hasStringFields(c.costOfInaction, ['inaction', 'action']) &&
    hasStringFields(c.objectionReframe, ['objection', 'reframe']) &&
    hasStringFields(c.marketingTranslation, ['stopSaying', 'startSaying'])
  )
}

// Explicit buy-in step. Body carries the (possibly edited) chosen candidate
// plus the shared zoneOfImpact/intersection/uniquelyEquipped fields (also
// editable). candidate.id must match the analysis's current selected_id —
// call /select first. The other 2 candidates are kept in the stored record
// as originally generated; only the confirmed one is updated with edits.
// Until this is called, the analysis is a draft under review (confirmed: false).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { zoneOfImpact, intersection, uniquelyEquipped, candidate } = body

  const validShared =
    typeof zoneOfImpact === 'string' &&
    zoneOfImpact.trim().length > 0 &&
    Array.isArray(intersection) &&
    intersection.length > 0 &&
    intersection.every((s) => typeof s === 'string') &&
    Array.isArray(uniquelyEquipped) &&
    uniquelyEquipped.length > 0 &&
    uniquelyEquipped.every((s) => typeof s === 'string')

  if (!validShared || !isValidCandidate(candidate)) {
    return res.status(400).json({
      error: 'Invalid confirm payload — expects zoneOfImpact (string), intersection/uniquelyEquipped (string[]), and a full candidate object',
    })
  }

  try {
    const analysisRow = await getSavedOutput(userId, 'transformation_analysis')
    if (!analysisRow) return res.status(404).json({ error: 'No analysis generated yet' })

    const analysis = analysisRow.content as TransformationAnalysis

    if (analysis.selected_id !== candidate.id) {
      return res.status(400).json({ error: 'candidate.id must match the currently selected_id — call /select first' })
    }

    const updatedProblems = analysis.selectedProblems.map((c) => (c.id === candidate.id ? candidate : c))

    const updated: TransformationAnalysis = {
      zoneOfImpact: zoneOfImpact as string,
      intersection: intersection as string[],
      uniquelyEquipped: uniquelyEquipped as string[],
      // Top-level before/after are derived from the conversation, not edited in
      // this step — carry them straight over from the stored analysis so they
      // survive confirmation.
      beforeState: analysis.beforeState ?? '',
      afterState: analysis.afterState ?? '',
      selectedProblems: updatedProblems,
      selected_id: candidate.id,
      confirmed: true,
    }

    await saveOutput(userId, 'transformation_analysis', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[transformation/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
