import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { ProgramAnalysis, WeeklyBreakdownEntry } from '../../../lib/programAnalysis'
import { CoreOffersAnalysis } from '../../../lib/coreOffersAnalysis'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'
import { checkSyncGate } from '../../../lib/syncGate'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isValidWeeklyEntry(v: unknown): v is WeeklyBreakdownEntry {
  if (!v || typeof v !== 'object') return false
  const w = v as Record<string, unknown>
  return (
    typeof w.week === 'number' &&
    isNonEmptyString(w.phase_name) &&
    typeof w.session_focus === 'string' &&
    typeof w.client_milestone === 'string'
  )
}

// Step 3 (Monetize) — Program confirm. Explicit buy-in step: body carries the
// full (possibly edited) program, sets confirmed: true, and stamps the
// 'program' sync_snapshot. Same persistence + sync stamping as
// api/toolkits/program/confirm.ts, differing only in the capability gate
// (method_steps — the method itself — rather than the paid toolkits gate), so a
// coach can complete the program inside Step 3 without a separate toolkit trip.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Capability gate — confirm/save of a Step 3 output is part of the method
  // itself, so method_steps (every tier but free; admin bypasses).
  if (!(await requireCapability(userId, 'method_steps', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const {
    program_name,
    session_type,
    total_weeks,
    total_sessions,
    session_length_minutes,
    timeline_reasoning,
    weekly_breakdown,
    deliverables,
    suggested_starting_price,
    suggested_capacity_per_month,
  } = body

  const valid =
    isNonEmptyString(program_name) &&
    typeof session_type === 'string' &&
    typeof total_weeks === 'number' &&
    typeof total_sessions === 'number' &&
    typeof session_length_minutes === 'number' &&
    typeof timeline_reasoning === 'string' &&
    Array.isArray(weekly_breakdown) &&
    weekly_breakdown.length > 0 &&
    weekly_breakdown.every(isValidWeeklyEntry) &&
    Array.isArray(deliverables) &&
    deliverables.every((d) => typeof d === 'string') &&
    isNonEmptyString(suggested_starting_price) &&
    typeof suggested_capacity_per_month === 'number'

  if (!valid) {
    return res.status(400).json({
      error:
        'Invalid confirm payload — expects program_name/suggested_starting_price (non-empty strings), session_type/timeline_reasoning (strings), total_weeks/total_sessions/session_length_minutes/suggested_capacity_per_month (numbers), weekly_breakdown (non-empty array of {week, phase_name, session_focus, client_milestone}), and deliverables (string[])',
    })
  }

  try {
    const existing = await getSavedOutput(userId, 'program')
    if (!existing) return res.status(404).json({ error: 'No program generated yet' })

    const syncGate = await checkSyncGate(userId, 'program')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    // The program IS the confirmed high-ticket core offer, so its price is the
    // single source of truth shared with core_offers.high_ticket.price_point. If
    // the coach edited the price here, propagate it back into core_offers — ONLY
    // high_ticket.price_point changes; every other field (low_ticket/mid_ticket,
    // confirmed, next_step_bridge, its own sync_snapshot) is preserved. This runs
    // BEFORE the stamp below so the program's fresh sync snapshot captures the
    // just-updated core_offers timestamp and isn't flagged stale against its own
    // edit. No-op when the price is unchanged. (content/qualifier depend on
    // core_offers and will correctly show stale after a price change.)
    const coreOffersRow = await getSavedOutput(userId, 'core_offers')
    const coreOffers = coreOffersRow?.content as CoreOffersAnalysis | undefined
    if (
      coreOffers &&
      coreOffers.confirmed === true &&
      coreOffers.high_ticket &&
      coreOffers.high_ticket.price_point !== suggested_starting_price
    ) {
      const updatedCoreOffers: CoreOffersAnalysis = {
        ...coreOffers,
        high_ticket: { ...coreOffers.high_ticket, price_point: suggested_starting_price as string },
      }
      await saveOutput(userId, 'core_offers', updatedCoreOffers)
    }

    const sync_snapshot = await stampSyncSnapshot(userId, 'program')

    const updated: ProgramAnalysis = {
      program_name,
      session_type,
      total_weeks,
      total_sessions,
      session_length_minutes,
      timeline_reasoning,
      weekly_breakdown: weekly_breakdown as WeeklyBreakdownEntry[],
      deliverables: deliverables as string[],
      suggested_starting_price,
      suggested_capacity_per_month,
      confirmed: true,
      sync_snapshot,
    }

    await saveOutput(userId, 'program', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[matcher/program/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
