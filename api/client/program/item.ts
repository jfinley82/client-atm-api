import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { loadTokenProgram, loadOwnedChild } from '../../../lib/clientProgramAccess'

// POST /api/client/program/item?t=<token> — body { item_id, status }. PUBLIC.
//
// THE ONLY THING A CLIENT MAY CHANGE ON THEIR PLAN. Not the title, not the due
// date, not the position — a tick, and back again. The allowlist is the body
// shape itself: two keys, one of which is an id and the other of which has two
// legal values.
//
// AUTHORIZED FROM THE TOKEN, NEVER FROM THE BODY. `item_id` is a claim. The
// token names one program, so the item must prove it belongs to THAT program
// before anything is written — otherwise anyone holding any valid portal link
// could tick items on every program in the table by naming their ids.
export const config = { maxDuration: 30 }

const ITEM_COLUMNS = 'id, program_id, kind, title, status, completed_at, completed_by, due_date, sequence_position'

type Item = {
  id: string
  program_id: string
  kind: 'week' | 'task' | 'milestone'
  status: 'pending' | 'completed'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const loaded = await loadTokenProgram(req.query.t)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })
  const program = loaded.program

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const itemId = typeof body.item_id === 'string' ? body.item_id : ''
  const status = body.status
  if (status !== 'pending' && status !== 'completed') {
    return res.status(400).json({ error: 'invalid_field', field: 'status', allowed: ['pending', 'completed'] })
  }

  try {
    // The second check. Same helper the coach routes use, with the token's
    // program as the parent instead of a program from the URL.
    const item = await loadOwnedChild<Item>('client_program_items', ITEM_COLUMNS, itemId, program.id)
    // 404, not 403: an item on another program is indistinguishable from one
    // that does not exist, and it is left completely untouched.
    if (!item) return res.status(404).json({ error: 'not_found' })

    // A `week` row is a heading, not work. It carries no due date and is excluded
    // from progress, so ticking one would be a completion that counts for nothing
    // and shows up in the coach's activity as if it did.
    if (item.kind !== 'task' && item.kind !== 'milestone') {
      return res.status(400).json({ error: 'invalid_item', kind: item.kind })
    }

    const completed = status === 'completed'
    const { data, error } = await supabase
      .from('client_program_items')
      .update({
        status,
        completed_at: completed ? new Date().toISOString() : null,
        // WHO ticked it is a different fact from whether it is ticked, and only
        // one of them is evidence the client is engaged. This route is the
        // client's, and it is the only place that writes 'client'.
        completed_by: completed ? 'client' : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id)
      // Belt and braces on the scoping: even with the check above, the write
      // itself names the program. A query that can only ever touch one program's
      // rows cannot be widened by an edit to the lines above it.
      .eq('program_id', program.id)
      .select(ITEM_COLUMNS)
      .single()
    if (error) throw error

    return res.status(200).json({ item: data })
  } catch (err) {
    console.error('[client/program/item]', err)
    return res.status(500).json({ error: 'Failed to update item' })
  }
}
