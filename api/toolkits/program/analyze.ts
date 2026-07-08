import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateProgram, ProgramAnalysis } from '../../../lib/programAnalysis'
import { checkAudienceComplete, checkFrameworkConfirmed, checkCoreOffersConfirmed } from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'

// Toolkit: High Ticket Offer Creator (program). Turns the confirmed
// high-ticket Core Offer into an actual sellable program structure.
//
// Gate is an EXPLICIT triple-check (audience.completed AND framework.confirmed
// AND core_offers.confirmed) — NOT solely core_offers.confirmed. core_offers.
// confirmed only proves those were true at the moment Core Offers was
// generated: transformation/select.ts and framework/select.ts both reset
// their own `confirmed` to false on re-selection, and neither touches
// core_offers when they do (confirmed from source — no invalidation cascade
// exists anywhere in this codebase). So core_offers.confirmed can go stale
// while still reading true. Checking all three explicitly, the same
// discipline core_offers/analyze.ts itself uses, is what actually stays safe.
//
// GET: return the stored program (404 if none generated yet).
// POST: generate a fresh program from the confirmed high_ticket offer +
// framework + audience, persist as a draft (confirmed: false), and return it.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'program')
      if (!saved) return res.status(404).json({ error: 'No program generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[toolkits/program/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load program' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Tier gate — base tier, same as Audience/Transform/Matcher (not a new add-on)
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  try {
    const audienceGate = await checkAudienceComplete(userId)
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.error })

    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

    const coreOffersGate = await checkCoreOffersConfirmed(userId)
    if (!coreOffersGate.ok) return res.status(400).json({ error: coreOffersGate.error })

    const audienceRow = await getSavedOutput(userId, 'audience')
    const voiceContext = await getVoiceContext(userId)

    const frameworkContext = {
      frameworkName: frameworkGate.framework.frameworkName,
      frameworkTagline: frameworkGate.framework.frameworkTagline,
      phases: frameworkGate.framework.phases,
      descriptiveCopy: frameworkGate.framework.descriptiveCopy,
    }

    const generated = await generateProgram(
      coreOffersGate.coreOffers.high_ticket,
      frameworkContext,
      stripSessionHistory(audienceRow!.content),
      voiceContext
    )

    if (!generated.program_name || generated.weekly_breakdown.length === 0) {
      console.error('[toolkits/program/analyze] generation returned malformed output', {
        program_name: generated.program_name,
        weekly_breakdown_count: generated.weekly_breakdown.length,
      })
      return res.status(502).json({ error: 'Program generation failed' })
    }

    const program: ProgramAnalysis = {
      ...generated,
      // Deterministic override — never trust the model's own paraphrasing of
      // an exact price string (same principle as PHASE_COLORS/
      // resolveFrameworkName/match_strength being backend-computed).
      suggested_starting_price: coreOffersGate.coreOffers.high_ticket.price_point,
      confirmed: false,
    }

    await saveOutput(userId, 'program', program)

    return res.status(200).json(program)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[toolkits/program/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[toolkits/program/analyze] POST', err)
    return res.status(500).json({ error: 'Program generation failed' })
  }
}
