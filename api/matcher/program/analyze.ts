import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateProgram, ProgramAnalysis, ProgramCoachInputs } from '../../../lib/programAnalysis'
import { checkAudienceComplete, checkFrameworkConfirmed, checkCoreOffersConfirmed } from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'
import { checkSyncGate } from '../../../lib/syncGate'

// Step 3 (Monetize) — Program. The program is the centerpiece of Step 3: the
// actual delivery structure the confirmed high-ticket offer sells, generated
// and confirmed inside the method flow (not only from the gated AI Toolkits).
//
// Same generator + persistence (saved_outputs tool_type 'program') as
// api/toolkits/program/analyze.ts — this is the SAME capability surfaced in the
// Step 3 context, differing only in the capability gate (method_steps, the
// method itself, rather than the paid toolkits gate) and in accepting the
// coach's delivery_model / preferred_weeks / capacity_per_month decisions.
//
// Gate is the same explicit triple-check the toolkit uses (audience.completed
// AND framework.confirmed AND core_offers.confirmed) — core_offers.confirmed
// alone can read stale, so all three are checked, plus the 'program' sync gate.
//
// GET: return the stored program (404 if none generated yet).
// POST: generate a fresh program from the confirmed high_ticket offer +
// framework + audience, honoring the coach's inputs, persist as a draft
// (confirmed: false), and return it.
export const config = { maxDuration: 60 }

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
      console.error('[matcher/program/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load program' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Capability gate — Step 3 is the method itself, so method_steps (every tier
  // but free; admin bypasses), NOT the paid toolkits gate the toolkit uses.
  if (!(await requireCapability(userId, 'method_steps', res))) return

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

    // The coach's Step 3 decisions (any subset). Each invalid/omitted value is
    // treated as absent by generateProgram, which keeps today's default.
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const coachInputs: ProgramCoachInputs = {
      delivery_model:
        typeof body.delivery_model === 'string' ? (body.delivery_model as ProgramCoachInputs['delivery_model']) : undefined,
      preferred_weeks: typeof body.preferred_weeks === 'number' ? body.preferred_weeks : undefined,
      capacity_per_month: typeof body.capacity_per_month === 'number' ? body.capacity_per_month : undefined,
    }
    // Optional coach-edited price for this regenerate. A regenerate is only a
    // draft preview, so this pins the draft's displayed price without writing to
    // core_offers (that propagation happens at confirm). Absent -> keep pinning
    // to the confirmed high-ticket price.
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
      voiceContext,
      coachInputs
    )

    if (!generated.program_name || generated.weekly_breakdown.length === 0) {
      console.error('[matcher/program/analyze] generation returned malformed output', {
        program_name: generated.program_name,
        weekly_breakdown_count: generated.weekly_breakdown.length,
      })
      return res.status(502).json({ error: 'Program generation failed' })
    }

    const program: ProgramAnalysis = {
      ...generated,
      // Deterministic override — price is pinned to the coach's edited price
      // when supplied, otherwise the confirmed high-ticket price. Never the
      // model's paraphrase (same principle as the coach-input overrides applied
      // inside generateProgram).
      suggested_starting_price: editedPrice ?? coreOffersGate.coreOffers.high_ticket.price_point,
      confirmed: false,
    }

    await saveOutput(userId, 'program', program)

    return res.status(200).json(program)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[matcher/program/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[matcher/program/analyze] POST', err)
    return res.status(500).json({ error: 'Program generation failed' })
  }
}
