import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory, isContentComplete } from '../../../lib/savedOutputs'
import { TransformationAnalysis } from '../../../lib/transformationAnalysis'
import { FrameworkAnalysis } from '../../../lib/frameworkAnalysis'
import { MatcherIntake } from '../../../lib/matcherAnalysis'
import { generateCoreOffers, CoreOffersAnalysis } from '../../../lib/coreOffersAnalysis'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'

// Step 3 capstone: Core Offers. Runs only once everything upstream is
// genuinely done — not merely present:
//   - audience session must be COMPLETE (content.completed === true)
//   - transformation_analysis must be CONFIRMED (the member picked and
//     confirmed one of their 3 transformation candidates)
//   - framework must be CONFIRMED (the member confirmed their named results
//     framework)
//   - exactly 3 validated problem_solution_cards must exist (the 3 finalized
//     Blueprints from matcher/finalize) — not "at least 3": a matcher restart
//     deliberately leaves old finalized cards in place (see
//     lib/savedOutputs.ts RESET_KEYS), so a member who restarted and
//     refinalized could have more than 3. Rather than silently guessing which
//     3 to use, any count other than exactly 3 fails this gate closed.
//
// GET: return the stored core offers (404 if none generated yet).
// POST: generate fresh low_ticket/high_ticket offers from ALL available
// context (audience, confirmed transformation, confirmed framework, the 3
// finalized blueprints, and the original intake's existing-offer data),
// persist as a draft (confirmed: false), and return it.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'core_offers')
      if (!saved) return res.status(404).json({ error: 'No core offers generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[matcher/core-offers/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load core offers' })
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
    const [audienceRow, transformationAnalysisRow, frameworkRow, intakeRow, cardsResult] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'transformation_analysis'),
      getSavedOutput(userId, 'framework'),
      getSavedOutput(userId, 'matcher_intake'),
      supabase
        .from('problem_solution_cards')
        .select('card_name, problem_text, reasoning, suggested_offer')
        .eq('user_id', userId)
        .eq('validated', true),
    ])

    if (!isContentComplete(audienceRow?.content)) {
      return res.status(400).json({ error: 'audience_incomplete' })
    }

    const transformationAnalysis = transformationAnalysisRow?.content as TransformationAnalysis | undefined
    if (!transformationAnalysis || transformationAnalysis.confirmed !== true) {
      return res.status(400).json({ error: 'transformation_not_confirmed' })
    }

    const framework = frameworkRow?.content as FrameworkAnalysis | undefined
    if (!framework || framework.confirmed !== true) {
      return res.status(400).json({ error: 'framework_not_confirmed' })
    }

    if (cardsResult.error) throw cardsResult.error
    const blueprints = cardsResult.data || []
    if (blueprints.length !== 3) {
      console.error('[matcher/core-offers/analyze] blueprint count check failed', { count: blueprints.length })
      return res.status(400).json({ error: 'blueprints_incomplete' })
    }

    // The confirmed candidate is the one whose id matches selected_id — same
    // construction framework/analyze.ts uses to feed Part B, so Core Offers'
    // high_ticket is grounded in the SAME confirmed transformation, not all 3
    // candidates.
    const confirmedCandidate = transformationAnalysis.selectedProblems.find(
      (c) => c.id === transformationAnalysis.selected_id
    )
    if (!confirmedCandidate) {
      return res.status(400).json({ error: 'transformation_not_confirmed' })
    }

    const confirmedTransformationContext = {
      zoneOfImpact: transformationAnalysis.zoneOfImpact,
      intersection: transformationAnalysis.intersection,
      uniquelyEquipped: transformationAnalysis.uniquelyEquipped,
      beforeState: transformationAnalysis.beforeState,
      afterState: transformationAnalysis.afterState,
      confirmedTransformation: confirmedCandidate,
    }

    const frameworkContext = {
      frameworkName: framework.frameworkName,
      frameworkTagline: framework.frameworkTagline,
      phases: framework.phases,
      descriptiveCopy: framework.descriptiveCopy,
      useCases: framework.useCases,
      audienceLanguage: framework.audienceLanguage,
    }

    const intake = intakeRow ? (stripSessionHistory(intakeRow.content) as MatcherIntake) : { has_existing_offer: false }
    const voiceContext = await getVoiceContext(userId)

    const { low_ticket, high_ticket } = await generateCoreOffers(
      stripSessionHistory(audienceRow!.content),
      confirmedTransformationContext,
      frameworkContext,
      blueprints,
      intake,
      voiceContext
    )

    if (!low_ticket.name || !high_ticket.name) {
      console.error('[matcher/core-offers/analyze] generation returned malformed output', {
        low_ticket_name: low_ticket.name,
        high_ticket_name: high_ticket.name,
      })
      return res.status(502).json({ error: 'Core offers generation failed' })
    }

    const analysis: CoreOffersAnalysis = {
      low_ticket,
      high_ticket,
      confirmed: false,
    }

    await saveOutput(userId, 'core_offers', analysis)

    return res.status(200).json(analysis)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[matcher/core-offers/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[matcher/core-offers/analyze] POST', err)
    return res.status(500).json({ error: 'Core offers generation failed' })
  }
}
