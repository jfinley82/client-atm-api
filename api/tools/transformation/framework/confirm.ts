import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors } from '../../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../../lib/savedOutputs'
import { FrameworkAnalysis, FrameworkPhase, FrameworkStep, PHASE_COLORS } from '../../../../lib/frameworkAnalysis'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isValidStep(v: unknown): v is FrameworkStep {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    isNonEmptyString(s.name) &&
    typeof s.description === 'string' &&
    typeof s.outcome === 'string'
  )
}

function isValidPhase(v: unknown): v is FrameworkPhase {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    isNonEmptyString(p.name) &&
    typeof p.tagline === 'string' &&
    Array.isArray(p.steps) &&
    p.steps.length >= 2 &&
    p.steps.length <= 3 &&
    p.steps.every(isValidStep)
  )
}

// Explicit buy-in step for Part B. Body carries the full (possibly edited)
// framework: frameworkName/frameworkTagline (resolved from the selected option
// or a custom override), and the editable phases/steps/descriptiveCopy/
// useCases/audienceLanguage. name_options and selected_name_id are carried over
// from the stored draft (name choice is driven by /select, not this step).
// Colors are re-asserted deterministically so edited phases keep their fixed
// slot color. Sets confirmed: true.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { frameworkName, frameworkTagline, phases, descriptiveCopy, useCases, audienceLanguage } = body

  const valid =
    isNonEmptyString(frameworkName) &&
    typeof frameworkTagline === 'string' &&
    Array.isArray(phases) &&
    phases.length === 3 &&
    phases.every(isValidPhase) &&
    typeof descriptiveCopy === 'string' &&
    Array.isArray(useCases) &&
    useCases.every((u) => typeof u === 'string') &&
    typeof audienceLanguage === 'string'

  if (!valid) {
    return res.status(400).json({
      error:
        'Invalid confirm payload — expects frameworkName (non-empty string), frameworkTagline (string), exactly 3 phases (each with 2-3 steps), descriptiveCopy (string), useCases (string[]), and audienceLanguage (string)',
    })
  }

  try {
    const frameworkRow = await getSavedOutput(userId, 'framework')
    if (!frameworkRow) return res.status(404).json({ error: 'No framework generated yet' })

    const stored = frameworkRow.content as FrameworkAnalysis

    // Re-assert colors deterministically by index — the body's color values are
    // ignored so an edited/reordered phase always carries its fixed slot color.
    const coloredPhases: FrameworkPhase[] = (phases as FrameworkPhase[]).map((p, i) => ({
      ...p,
      color: PHASE_COLORS[i],
    }))

    const updated: FrameworkAnalysis = {
      frameworkName: frameworkName as string,
      frameworkTagline: frameworkTagline as string,
      phases: coloredPhases,
      descriptiveCopy: descriptiveCopy as string,
      useCases: useCases as string[],
      audienceLanguage: audienceLanguage as string,
      // Name choice is driven by /select; carry the selection metadata over from
      // the stored draft so it survives confirmation.
      name_options: stored.name_options,
      selected_name_id: stored.selected_name_id,
      confirmed: true,
    }

    await saveOutput(userId, 'framework', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[transformation/framework/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
