import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors } from '../../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../../lib/funnels'

// PATCH /api/funnels/[id]/leads/[leadId] — owner-scoped lead management.
// Accepts status (lead | booked | closed), close_amount (number | null), and
// notes (string). Validates, rejects unknown fields, updates the lead scoped to
// the owned funnel, and returns the updated row.
const ALLOWED_STATUS = ['lead', 'booked', 'closed']
const EDITABLE_KEYS = new Set(['status', 'close_amount', 'notes'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  const leadId = req.query.leadId as string
  if (!id || !leadId) return res.status(400).json({ error: 'id and leadId required' })

  // Ownership is on the funnel; the update is scoped to funnel_id below so a lead
  // from another funnel can't be touched even with a guessed leadId.
  const funnel = await getOwnedFunnel(userId, id)
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  // Reject unknown keys rather than silently dropping them.
  for (const key of Object.keys(body)) {
    if (!EDITABLE_KEYS.has(key)) return res.status(400).json({ error: 'unknown_field', field: key })
  }

  const updates: Record<string, unknown> = {}

  if ('status' in body) {
    if (typeof body.status !== 'string' || !ALLOWED_STATUS.includes(body.status)) {
      return res.status(400).json({ error: 'invalid_field', field: 'status', message: `status must be one of ${ALLOWED_STATUS.join(', ')}` })
    }
    updates.status = body.status
  }

  if ('close_amount' in body) {
    const v = body.close_amount
    if (v === null) {
      updates.close_amount = null
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      updates.close_amount = v
    } else {
      return res.status(400).json({ error: 'invalid_field', field: 'close_amount', message: 'must be a non-negative number or null' })
    }
  }

  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      return res.status(400).json({ error: 'invalid_field', field: 'notes', message: 'must be a string or null' })
    }
    updates.notes = body.notes === null ? null : (body.notes as string)
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' })
  }

  try {
    const { data, error } = await supabase
      .from('funnel_leads')
      .update(updates)
      .eq('id', leadId)
      .eq('funnel_id', id)
      .select('id, first_name, email, phone, status, close_amount, notes, opted_in_at, created_at')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Lead not found' })
    return res.status(200).json({ lead: data })
  } catch (err) {
    console.error('[funnels/[id]/leads/[leadId]] PATCH', err)
    return res.status(500).json({ error: 'Failed to update lead' })
  }
}
