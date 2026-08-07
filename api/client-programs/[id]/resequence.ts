import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'
import { loadOwnedProgram, ITEM_COLUMNS } from '../../../lib/clientProgramAccess'
import { redriveDueDates } from '../../../lib/clientProgramPlan'
import { syncChangedReminders, type ReminderItem } from '../../../lib/clientProgramEmail'

// PATCH /api/client-programs/[id]/resequence — { positions: [{item_id, sequence_position}] }
//
// REJECT THE WHOLE PAYLOAD ON ANY VIOLATION, never repair silently. A partially
// applied resequence leaves the plan in a state the program's own endpoints
// refuse — gapped positions fail this very contiguity rule on the next call —
// and the coach has no way to see which half landed.
//
// NEVER TOUCHES source_week. Position is where the client is; source_week is
// what their coach called it. Renumbering both would erase the only record that
// this client started at week 4 of the method.
export const config = { maxDuration: 30 }

type Item = { id: string; sequence_position: number; due_date: string | null; due_date_source: 'derived' | 'manual' }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  try {
    const program = await loadOwnedProgram(userId, id)
    if (!program) return res.status(404).json({ error: 'not_found' })

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const positions = Array.isArray(body.positions) ? body.positions : null
    if (!positions || !positions.length) return res.status(400).json({ error: 'invalid_sequence', reason: 'positions required' })

    const { data, error } = await supabase.from('client_program_items').select(ITEM_COLUMNS).eq('program_id', program.id)
    if (error) throw error
    const items = (data || []) as unknown as Item[]

    const byId = new Map(items.map((i) => [i.id, i]))
    const seen = new Set<string>()
    const next = new Map<string, number>()

    for (const raw of positions) {
      const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const itemId = typeof entry.item_id === 'string' ? entry.item_id : ''
      const pos = entry.sequence_position
      // Every id must belong to THIS program. An id from another program would
      // otherwise be moved by whoever could name it.
      if (!itemId || !byId.has(itemId)) return res.status(400).json({ error: 'invalid_sequence', reason: 'unknown item_id' })
      if (seen.has(itemId)) return res.status(400).json({ error: 'invalid_sequence', reason: 'duplicate item_id' })
      if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1) {
        return res.status(400).json({ error: 'invalid_sequence', reason: 'sequence_position must be a positive integer' })
      }
      seen.add(itemId)
      next.set(itemId, pos)
    }

    // COMPLETE COVERAGE REQUIRED. A partial payload leaves untouched items at
    // their old positions, and whether the result is contiguous then depends on
    // rows the caller never mentioned — so "is this payload valid" would have an
    // answer that changes with data the caller cannot see.
    if (seen.size !== items.length) {
      return res.status(400).json({ error: 'invalid_sequence', reason: 'every item must be listed', expected: items.length, got: seen.size })
    }

    const distinct = [...new Set([...next.values()])].sort((a, b) => a - b)
    const contiguous = distinct.every((p, n) => p === n + 1)
    if (!contiguous) {
      return res.status(400).json({ error: 'invalid_sequence', reason: 'positions must be contiguous from 1', positions: distinct })
    }

    // Dates follow positions, and only for rows the coach did not date by hand.
    const moved = items.map((i) => ({ ...i, sequence_position: next.get(i.id) as number }))
    const dated = redriveDueDates(moved, program.start_date)

    for (const row of dated) {
      const before = byId.get(row.id) as Item
      if (before.sequence_position === row.sequence_position && before.due_date === row.due_date) continue
      const { error: updErr } = await supabase
        .from('client_program_items')
        .update({ sequence_position: row.sequence_position, due_date: row.due_date })
        .eq('id', row.id)
      if (updErr) throw updErr
    }

    const { data: after } = await supabase.from('client_program_items').select(ITEM_COLUMNS).eq('program_id', program.id)
    // Only the rows whose DATE moved. A reminder is keyed on the due date, so a
    // row that changed position without changing date keeps the message it
    // already has.
    await syncChangedReminders(program, items, (after || []) as unknown as ReminderItem[])

    return res.status(200).json({ items: after || [] })
  } catch (err) {
    console.error('[client-programs/[id]/resequence]', err)
    return res.status(500).json({ error: 'Failed to resequence' })
  }
}
