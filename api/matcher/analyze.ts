import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory, isContentComplete } from '../../lib/savedOutputs'
import { generateTop10, generateSuggestedOffer, MatcherAnalysis, MatcherIntake, SuggestedOffer } from '../../lib/matcherAnalysis'
import { getVoiceContext } from '../../lib/voiceGuide'
import { GenerationParseError } from '../../lib/aiJson'

// GET: return the stored top-10 analysis (404 if none generated yet).
// POST: generate a fresh analysis from audience + transformation + the
// matcher intake, persist it, and return it. Requires all three to exist.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'matcher_analysis')
      if (!saved) return res.status(404).json({ error: 'No analysis generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[matcher/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load analysis' })
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
    const [audienceRow, transformationRow, intakeRow] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'transformation'),
      getSavedOutput(userId, 'matcher_intake'),
    ])

    // Require the source sessions to be COMPLETE, not merely present — under
    // per-turn persistence a row exists from the first message, so an existence
    // check would let analysis run on a half-finished (or transcript-only)
    // profile. content.completed is set only when the session genuinely ends.
    if (!isContentComplete(audienceRow?.content)) return res.status(400).json({ error: 'audience_incomplete' })
    if (!isContentComplete(transformationRow?.content)) return res.status(400).json({ error: 'transformation_incomplete' })
    if (!isContentComplete(intakeRow?.content)) return res.status(400).json({ error: 'intake_incomplete' })

    // Strip the transcript before using content as the profile / casting to
    // MatcherIntake, so it never bloats the generation prompts.
    const intake = stripSessionHistory(intakeRow!.content) as MatcherIntake
    const voiceContext = await getVoiceContext(userId)

    const { top_10, recommended_ids, why_recommended, insights } = await generateTop10(
      stripSessionHistory(audienceRow!.content),
      stripSessionHistory(transformationRow!.content),
      intake,
      voiceContext
    )

    if (top_10.length === 0 || recommended_ids.length !== 3) {
      console.error('[matcher/analyze] generation returned malformed output', {
        top_10_count: top_10.length,
        recommended_ids_count: recommended_ids.length,
      })
      return res.status(502).json({ error: 'Analysis generation failed' })
    }

    const byId = new Map(top_10.map((p) => [p.id, p]))
    const offerEntries = await Promise.all(
      recommended_ids.map(async (id): Promise<[string, SuggestedOffer] | null> => {
        const problem = byId.get(id)
        if (!problem) return null
        const offer = await generateSuggestedOffer(problem, intake, voiceContext)
        return [id, offer]
      })
    )

    const suggested_offers: Record<string, SuggestedOffer> = {}
    for (const entry of offerEntries) {
      if (entry) suggested_offers[entry[0]] = entry[1]
    }

    const analysis: MatcherAnalysis = {
      top_10,
      recommended_ids,
      selected_ids: recommended_ids,
      why_recommended,
      insights,
      suggested_offers,
    }

    await saveOutput(userId, 'matcher_analysis', analysis)

    return res.status(200).json(analysis)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[matcher/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[matcher/analyze] POST', err)
    return res.status(500).json({ error: 'Analysis failed' })
  }
}
