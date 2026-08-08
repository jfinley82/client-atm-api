import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder } from '../../../../lib/funnels'
import { loadOwnedProgram, ITEM_COLUMNS } from '../../../../lib/clientProgramAccess'
import { syncItemReminder, type ReminderItem } from '../../../../lib/clientProgramEmail'
import { derivedDueDate } from '../../../../lib/clientProgramPlan'

// POST /api/client-programs/[id]/items — add work to a client's plan.
//
// `kind: 'week'` IS REJECTED. Week rows come from the snapshot mapping, one per
// position, and a hand-added second one at the same position would give that
// position two headings — a shape the portal's renderer is built to assume
// cannot happen.
export const config = { maxDuration: 30 }

const ADDABLE_KINDS = new Set(['task', 'milestone'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  try {
    const program = await loadOwnedProgram(userId, id)
    if (!program) return res.status(404).json({ error: 'not_found' })

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const kind = typeof body.kind === 'string' ? body.kind : ''
    if (!ADDABLE_KINDS.has(kind)) return res.status(400).json({ error: 'invalid_field', field: 'kind', allowed: [...ADDABLE_KINDS] })

    const position = body.sequence_position
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'invalid_field', field: 'sequence_position' })
    }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return res.status(400).json({ error: 'invalid_field', field: 'title' })

    // A date the coach typed is MANUAL from the moment it is typed; one they
    // leave to us is derived from the position and moves when the plan moves.
    const hasDue = 'due_date' in body && body.due_date !== null && body.due_date !== undefined
    const dueDate = hasDue ? String(body.due_date) : derivedDueDate(program.start_date, position)
    if (hasDue && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) return res.status(400).json({ error: 'invalid_field', field: 'due_date' })

    // Appended after whatever is already at this position, so a new task never
    // displaces the week heading at sort_order 0.
    const { data: siblings } = await supabase
      .from('client_program_items')
      .select('sort_order')
      .eq('program_id', program.id)
      .eq('sequence_position', position)
    const nextSort = Math.max(0, ...((siblings || []) as { sort_order: number }[]).map((s) => s.sort_order + 1), 1)

    const { data: created, error } = await supabase
      .from('client_program_items')
      .insert({
        program_id: program.id,
        kind,
        sequence_position: position,
        // NULL, not the position. A coach-added task came from no snapshot week,
        // and stamping one would claim their method contains it.
        source_week: null,
        sort_order: nextSort,
        title,
        detail: typeof body.detail === 'string' ? body.detail.trim() || null : null,
        phase_name: typeof body.phase_name === 'string' ? body.phase_name.trim() || null : null,
        due_date: dueDate,
        due_date_source: hasDue ? 'manual' : 'derived',
      })
      .select(ITEM_COLUMNS)
      .single()
    if (error) throw error

    // Scheduled only if the programme is already live — wantsReminder refuses a
    // draft, so a task added during review queues nothing and POST .../send
    // picks it up with everything else.
    await syncItemReminder(program, created as unknown as ReminderItem)

    return res.status(201).json({ item: created })
  } catch (err) {
    console.error('[client-programs/[id]/items] POST', err)
    return res.status(500).json({ error: 'Failed to add item' })
  }
}
