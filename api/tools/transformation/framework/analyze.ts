import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors } from '../../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory, isContentComplete } from '../../../../lib/savedOutputs'
import { TransformationAnalysis } from '../../../../lib/transformationAnalysis'
import {
  generateFramework,
  resolveFrameworkName,
  FrameworkAnalysis,
  FrameworkPhase,
  PHASE_COLORS,
} from '../../../../lib/frameworkAnalysis'

// Transformation Part B: Your Results Framework.
// GET: return the stored framework (404 if none generated yet).
// POST: generate a fresh framework from the CONFIRMED transformation candidate
// + audience data, persist it as a draft (confirmed: false), and return it.
//
// Gating (Step 2 only — no Matcher/Monetize dependency, that's Step 3):
//   - audience session must be COMPLETE
//   - transformation Part A (transformation_analysis) must be CONFIRMED — the
//     member has actually picked and confirmed one of their 3 candidates.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'framework')
      if (!saved) return res.status(404).json({ error: 'No framework generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[transformation/framework/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load framework' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Tier gate — AI generation requires a paid membership tier
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  try {
    const [audienceRow, analysisRow] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'transformation_analysis'),
    ])

    // Audience must be a finished session — a row exists from the first turn
    // under per-turn persistence, so existence never implies completion.
    if (!isContentComplete(audienceRow?.content)) {
      return res.status(400).json({ error: 'audience_incomplete' })
    }

    // Transformation Part A must be CONFIRMED — not merely analyzed. The member
    // must have picked and confirmed one of their 3 candidates via /confirm,
    // which is the only thing that sets confirmed: true on this row.
    const analysis = analysisRow?.content as TransformationAnalysis | undefined
    if (!analysis || analysis.confirmed !== true) {
      return res.status(400).json({ error: 'transformation_not_confirmed' })
    }

    // The confirmed candidate is the one whose id matches selected_id. Feed it
    // (plus the shared positioning context) to the generator, not all 3.
    const confirmedCandidate = analysis.selectedProblems.find((c) => c.id === analysis.selected_id)
    if (!confirmedCandidate) {
      return res.status(400).json({ error: 'transformation_not_confirmed' })
    }

    const transformationContext = {
      zoneOfImpact: analysis.zoneOfImpact,
      intersection: analysis.intersection,
      uniquelyEquipped: analysis.uniquelyEquipped,
      beforeState: analysis.beforeState,
      afterState: analysis.afterState,
      confirmedTransformation: confirmedCandidate,
    }

    const generated = await generateFramework(
      transformationContext,
      stripSessionHistory(audienceRow!.content)
    )

    // Structural guard — the framework is unusable without exactly 3 named
    // options, exactly 3 phases, and 2-3 steps per phase.
    const phasesValid =
      generated.phases.length === 3 &&
      generated.phases.every((p) => p.steps.length >= 2 && p.steps.length <= 3)
    if (generated.nameOptions.length !== 3 || !phasesValid) {
      console.error('[transformation/framework/analyze] generation returned malformed output', {
        name_option_count: generated.nameOptions.length,
        phase_count: generated.phases.length,
        step_counts: generated.phases.map((p) => p.steps.length),
      })
      return res.status(502).json({ error: 'Framework generation failed' })
    }

    // Assign colors deterministically by phase index — never model-chosen.
    const phases: FrameworkPhase[] = generated.phases.map((p, i) => ({
      ...p,
      color: PHASE_COLORS[i],
    }))

    const { frameworkName, frameworkTagline } = resolveFrameworkName(
      generated.nameOptions,
      generated.selectedNameId
    )

    const framework: FrameworkAnalysis = {
      frameworkName,
      frameworkTagline,
      phases,
      descriptiveCopy: generated.descriptiveCopy,
      useCases: generated.useCases,
      audienceLanguage: generated.audienceLanguage,
      name_options: generated.nameOptions,
      selected_name_id: generated.selectedNameId,
      confirmed: false,
    }

    await saveOutput(userId, 'framework', framework)

    return res.status(200).json(framework)
  } catch (err) {
    console.error('[transformation/framework/analyze] POST', err)
    return res.status(500).json({ error: 'Framework generation failed' })
  }
}
