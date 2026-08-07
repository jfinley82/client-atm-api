import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder } from '../../../../lib/funnels'
import { loadOwnedProgram } from '../../../../lib/clientProgramAccess'

// POST /api/client-programs/[id]/notes
//
// `visibility` IS REQUIRED, never defaulted. A silent default decides who can
// read a note the coach is still typing, and both defaults are wrong: shared by
// default publishes a private observation, private by default quietly withholds
// something meant for the client. Asking is the only safe answer.
export const config = { maxDuration: 30 }

export const NOTE_COLUMNS = 'id, program_id, body, visibility, created_at'
const VISIBILITIES = new Set(['coach_only', 'coach_and_client'])

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
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) return res.status(400).json({ error: 'invalid_field', field: 'body' })

    if (!('visibility' in body)) return res.status(400).json({ error: 'visibility_required' })
    const visibility = body.visibility
    if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) {
      return res.status(400).json({ error: 'invalid_field', field: 'visibility', allowed: [...VISIBILITIES] })
    }

    const { data, error } = await supabase
      .from('client_program_notes')
      .insert({ program_id: program.id, body: text, visibility })
      .select(NOTE_COLUMNS)
      .single()
    if (error) throw error

    return res.status(201).json({ note: data })
  } catch (err) {
    console.error('[client-programs/[id]/notes] POST', err)
    return res.status(500).json({ error: 'Failed to add note' })
  }
}
