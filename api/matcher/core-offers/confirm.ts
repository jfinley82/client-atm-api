import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { CoreOffer, CoreOffersAnalysis, NEXT_STEP_BRIDGE } from '../../../lib/coreOffersAnalysis'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'
import { checkSyncGate } from '../../../lib/syncGate'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isValidOffer(v: unknown): v is CoreOffer {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    isNonEmptyString(o.name) &&
    isNonEmptyString(o.price_point) &&
    typeof o.why_this_price === 'string' &&
    typeof o.whats_included === 'string' &&
    typeof o.delivery_format === 'string' &&
    typeof o.why_it_fits === 'string' &&
    typeof o.is_refinement === 'boolean'
  )
}

// Explicit buy-in step for the Step 3 capstone. Body carries the full
// (possibly edited) low_ticket/high_ticket offers. Sets confirmed: true and
// adds next_step_bridge — a backend-computed constant (not model-generated,
// not client-supplied), pointing toward what's next now that the whole
// Blueprint arc (Attract -> Transform -> Monetize -> Core Offers) is done.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Capability gate — confirm/save of a Step 1-3 output is part of the method
  // itself, so method_steps (every tier but free; admin bypasses), NOT the paid
  // asset-toolkits gate. Still closes the analyze-gated-but-confirm-open gap.
  if (!(await requireCapability(userId, 'method_steps', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { low_ticket, mid_ticket, high_ticket } = body

  // low_ticket + high_ticket are required; mid_ticket is optional (null when
  // absent) so this stays deploy-order-independent from the frontend — an old
  // two-tier confirm form still works, and mid_ticket is validated only when
  // provided.
  if (!isValidOffer(low_ticket) || !isValidOffer(high_ticket)) {
    return res.status(400).json({
      error:
        'Invalid confirm payload — expects low_ticket and high_ticket, each with name/price_point (non-empty strings), why_this_price/whats_included/delivery_format/why_it_fits (strings), and is_refinement (boolean)',
    })
  }
  const midTicket = isValidOffer(mid_ticket) ? mid_ticket : null
  if (mid_ticket != null && midTicket === null) {
    return res.status(400).json({ error: 'Invalid mid_ticket — same offer fields as low_ticket/high_ticket' })
  }

  try {
    const existing = await getSavedOutput(userId, 'core_offers')
    if (!existing) return res.status(404).json({ error: 'No core offers generated yet' })

    const syncGate = await checkSyncGate(userId, 'core_offers')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    const sync_snapshot = await stampSyncSnapshot(userId, 'core_offers')

    const updated: CoreOffersAnalysis = {
      low_ticket,
      mid_ticket: midTicket,
      high_ticket,
      confirmed: true,
      next_step_bridge: NEXT_STEP_BRIDGE,
      sync_snapshot,
    }

    await saveOutput(userId, 'core_offers', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[matcher/core-offers/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
