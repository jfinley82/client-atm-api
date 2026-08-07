import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder } from '../../../../lib/funnels'
import { cancelFunnelSends } from '../../../../lib/email'
import { loadOwnedProgram, loadOwnedChild, ITEM_COLUMNS } from '../../../../lib/clientProgramAccess'
import { derivedDueDate } from '../../../../lib/clientProgramPlan'

// PATCH  /api/client-programs/[id]/items/[itemId]
// DELETE /api/client-programs/[id]/items/[itemId]
export const config = { maxDuration: 30 }

type Item = {
  id: string
  program_id: string
  kind: 'week' | 'task' | 'milestone'
  sequence_position: number
  due_date: string | null
  due_date_source: 'derived' | 'manual'
  status: 'pending' | 'completed'
  reminder_message_id: string | null
}

const PATCHABLE = new Set(['title', 'detail', 'due_date', 'status', 'sequence_position', 'sort_order', 'phase_name'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : ''

  try {
    const program = await loadOwnedProgram(userId, id)
    if (!program) return res.status(404).json({ error: 'not_found' })
    const item = await loadOwnedChild<Item>('client_program_items', ITEM_COLUMNS, itemId, program.id)
    if (!item) return res.status(404).json({ error: 'not_found' })

    if (req.method === 'DELETE') return deleteItem(res, program.id, program.start_date, item)
    return patchItem(req, res, program.start_date, item)
  } catch (err) {
    console.error('[client-programs/[id]/items/[itemId]]', err)
    return res.status(500).json({ error: 'Failed to update item' })
  }
}

async function patchItem(req: VercelRequest, res: VercelResponse, startDate: string, item: Item) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (!PATCHABLE.has(key)) return res.status(400).json({ error: 'invalid_field', field: key })
  }

  const updates: Record<string, unknown> = {}

  if ('title' in body) {
    const v = typeof body.title === 'string' ? body.title.trim() : ''
    if (!v) return res.status(400).json({ error: 'invalid_field', field: 'title' })
    updates.title = v
  }
  for (const key of ['detail', 'phase_name'] as const) {
    if (key in body) updates[key] = typeof body[key] === 'string' ? String(body[key]).trim() || null : null
  }

  if ('due_date' in body) {
    // SETTING a date makes it the coach's; CLEARING it hands the row back to the
    // derivation. Without the second half a coach could never undo a manual date
    // — the column would be one-way and they would have to delete the item.
    if (body.due_date === null) {
      updates.due_date = derivedDueDate(startDate, item.sequence_position)
      updates.due_date_source = 'derived'
    } else {
      const v = String(body.due_date)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: 'invalid_field', field: 'due_date' })
      updates.due_date = v
      updates.due_date_source = 'manual'
    }
  }

  if ('sequence_position' in body) {
    const v = body.sequence_position
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return res.status(400).json({ error: 'invalid_field', field: 'sequence_position' })
    updates.sequence_position = v
    // The date follows the position, unless the coach owns the date.
    if (item.due_date_source === 'derived' && !('due_date' in body) && item.due_date !== null) {
      updates.due_date = derivedDueDate(startDate, v)
    }
  }

  if ('sort_order' in body) {
    const v = body.sort_order
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return res.status(400).json({ error: 'invalid_field', field: 'sort_order' })
    updates.sort_order = v
  }

  if ('status' in body) {
    const v = body.status
    if (v !== 'pending' && v !== 'completed') return res.status(400).json({ error: 'invalid_field', field: 'status' })
    updates.status = v
    // WHO ticked it is a different fact from whether it is ticked, and only one
    // of them is evidence of engagement. This route is the coach's.
    updates.completed_at = v === 'completed' ? new Date().toISOString() : null
    updates.completed_by = v === 'completed' ? 'coach' : null
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_changes' })
  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase.from('client_program_items').update(updates).eq('id', item.id).select(ITEM_COLUMNS).single()
  if (error) throw error
  return res.status(200).json({ item: data })
}

/**
 * Deleting a `week` row deletes the WHOLE POSITION and compacts.
 *
 * Leaving a gap (1,2,3,4,6,7) produces a plan the program's own resequence
 * endpoint then rejects as non-contiguous — a state reachable through the API
 * and refused by the API. Forbidding middle deletes is not the fix, because
 * coaches will want them; compaction is.
 *
 * REMINDERS ARE CANCELLED BEFORE THE ROWS GO. A deleted task whose reminder is
 * still queued emails the client about work that no longer exists, and once the
 * row is gone there is nothing left to find the message id on.
 */
async function deleteItem(res: VercelResponse, programId: string, startDate: string, item: Item) {
  const position = item.sequence_position
  const wholePosition = item.kind === 'week'

  const { data: all, error: readErr } = await supabase.from('client_program_items').select(ITEM_COLUMNS).eq('program_id', programId)
  if (readErr) throw readErr
  const items = (all || []) as unknown as Item[]

  const doomed = wholePosition ? items.filter((i) => i.sequence_position === position) : [item]

  const messageIds = doomed.map((i) => i.reminder_message_id).filter((m): m is string => !!m)
  if (messageIds.length) await cancelFunnelSends(messageIds)

  for (const d of doomed) {
    const { error } = await supabase.from('client_program_items').delete().eq('id', d.id)
    if (error) throw error
  }

  if (!wholePosition) {
    return res.status(200).json({ deleted: [item.id], compacted: false })
  }

  // Everything after the hole moves up one, and derived dates move with it.
  const later = items.filter((i) => i.sequence_position > position)
  for (const l of later) {
    const nextPosition = l.sequence_position - 1
    const patch: Record<string, unknown> = { sequence_position: nextPosition }
    if (l.due_date_source === 'derived' && l.due_date !== null) patch.due_date = derivedDueDate(startDate, nextPosition)
    const { error } = await supabase.from('client_program_items').update(patch).eq('id', l.id)
    if (error) throw error
  }

  const { data: after } = await supabase.from('client_program_items').select(ITEM_COLUMNS).eq('program_id', programId)
  return res.status(200).json({ deleted: doomed.map((d) => d.id), compacted: true, items: after || [] })
}
