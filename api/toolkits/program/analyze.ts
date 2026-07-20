import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateProgram, ProgramAnalysis } from '../../../lib/programAnalysis'
import { checkAudienceComplete, checkFrameworkConfirmed, checkCoreOffersConfirmed } from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'
import { checkSyncGate } from '../../../lib/syncGate'

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

  // Capability gate — toolkits require beta/full (admin bypasses); see lib/entitlements.ts
  if (!(await requireCapability(userId, 'toolkits', res))) return

  try {
    const audienceGate = await checkAudienceComplete(userId)
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.error })

    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

    const coreOffersGate = await checkCoreOffersConfirmed(userId)
    if (!coreOffersGate.ok) return res.status(400).json({ error: coreOffersGate.error })

    const syncGate = await checkSyncGate(userId, 'program')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    // Optional coach-edited price for this regenerate. A regenerate is only a
    // draft preview, so this pins the draft's displayed price without writing to
    // core_offers (that propagation happens at confirm). Absent -> keep pinning
    // to the confirmed high-ticket price.
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const editedPrice =
      typeof body.starting_price === 'string' && body.starting_price.trim().length > 0 ? body.starting_price.trim() : null

    const audienceRow = await getSavedOutput(userId, 'audience')
    const voiceContext = await getVoiceContext(userId)

    const frameworkContext = {
      frameworkName: frameworkGate.framework.frameworkName,
      frameworkTagline: frameworkGate.framework.frameworkTagline,
      phases: frameworkGate.framework.phases,
      descriptiveCopy: frameworkGate.framework.descriptiveCopy,
    }

    const generated = await generateProgram(
      userId,
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
      // Deterministic override — the coach's edited price when supplied,
      // otherwise the confirmed high-ticket price. Never the model's own
      // paraphrasing of an exact price string (same principle as PHASE_COLORS/
      // resolveFrameworkName/match_strength being backend-computed).
      suggested_starting_price: editedPrice ?? coreOffersGate.coreOffers.high_ticket.price_point,
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
