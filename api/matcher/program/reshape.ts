import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import type { ProgramAnalysis } from '../../../lib/programAnalysis'
import { checkAudienceComplete, checkFrameworkConfirmed, checkCoreOffersConfirmed } from '../../../lib/toolkitsShared'
import { checkSyncGate } from '../../../lib/syncGate'
import {
  reshapeProgram,
  isSessionCadence,
  SESSION_CADENCES,
  MIN_WEEKS,
  MAX_WEEKS,
  MIN_SESSION_MINUTES,
  MAX_SESSION_MINUTES,
} from '../../../lib/programReshape'

// POST /api/matcher/program/reshape — re-cut the stored program to the length,
// cadence and session length the coach chose in Step 3.
//
// WHY THIS IS A BACKEND WRITE AND NOT A CLIENT-SIDE REDISTRIBUTION. The
// frontend could spread the stored twelve entries across a shorter container on
// its own, and the result would be wrong in a way nobody sees: the stored row
// would still say twelve weeks while the coach's screen said eight, Step 4 and
// the PDF would build from the stored row, and the coach would find out at the
// worst possible moment — when they send the program to a client. The row the
// coach sees and the row the system builds from have to be the same row.
//
// Gated exactly as analyze and confirm are: method_steps, the explicit triple
// check (audience.completed AND framework.confirmed AND core_offers.confirmed),
// and the 'program' sync gate. A reshape is a write to a downstream artifact,
// so it belongs behind the same gate the other writes do — a coach whose
// framework moved underneath them must not be able to re-cut a plan against
// steps that no longer exist.
//
// The reshape itself is deterministic (lib/programReshape.ts). No model call,
// so no maxDuration bump and no generation failure mode.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method !== 'POST') return res.status(405).end()

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

    const existingRow = await getSavedOutput(userId, 'program')
    if (!existingRow) return res.status(404).json({ error: 'No program generated yet' })
    const existing = existingRow.content as ProgramAnalysis

    // ── Validation. Every failure writes NOTHING and says what was wrong in a
    // sentence rather than a code the coach has to look up — this is a control
    // they are operating, not a machine-to-machine call.
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

    const totalWeeks = body.total_weeks
    if (typeof totalWeeks !== 'number' || !Number.isInteger(totalWeeks) || totalWeeks < MIN_WEEKS || totalWeeks > MAX_WEEKS) {
      return res.status(400).json({
        error: 'invalid_total_weeks',
        message: `total_weeks must be a whole number between ${MIN_WEEKS} and ${MAX_WEEKS}. Received ${JSON.stringify(totalWeeks)}.`,
      })
    }

    if (!isSessionCadence(body.session_cadence)) {
      return res.status(400).json({
        error: 'invalid_session_cadence',
        message: `session_cadence must be one of ${SESSION_CADENCES.join(', ')}. Received ${JSON.stringify(body.session_cadence)}.`,
      })
    }

    const sessionLength = body.session_length_minutes
    if (
      typeof sessionLength !== 'number' ||
      !Number.isInteger(sessionLength) ||
      sessionLength < MIN_SESSION_MINUTES ||
      sessionLength > MAX_SESSION_MINUTES
    ) {
      return res.status(400).json({
        error: 'invalid_session_length_minutes',
        message: `session_length_minutes must be a whole number of minutes between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES}. Received ${JSON.stringify(sessionLength)}.`,
      })
    }

    // A framework with no steps cannot be laid across a calendar, and producing
    // an empty plan would look like success. Refuse instead.
    const stepCount = frameworkGate.framework.phases.reduce((n, p) => n + (p.steps?.length ?? 0), 0)
    if (stepCount === 0) {
      return res.status(400).json({
        error: 'framework_has_no_steps',
        message: 'This framework has no steps to lay across a schedule. Regenerate the framework in Step 2 first.',
      })
    }

    const reshaped = reshapeProgram(
      existing,
      { frameworkName: frameworkGate.framework.frameworkName, phases: frameworkGate.framework.phases },
      {
        total_weeks: totalWeeks,
        session_cadence: body.session_cadence,
        session_length_minutes: sessionLength,
      }
    )

    await saveOutput(userId, 'program', reshaped)

    return res.status(200).json(reshaped)
  } catch (err) {
    console.error('[matcher/program/reshape] POST', err)
    return res.status(500).json({ error: 'Failed to reshape program' })
  }
}
