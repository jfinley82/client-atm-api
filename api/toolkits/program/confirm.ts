import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { ProgramAnalysis, WeeklyBreakdownEntry } from '../../../lib/programAnalysis'

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

// Explicit buy-in step. Body carries the full (possibly edited) program.
// Sets confirmed: true.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

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
    }

    await saveOutput(userId, 'program', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[toolkits/program/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
