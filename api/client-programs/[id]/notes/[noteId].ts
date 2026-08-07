import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder } from '../../../../lib/funnels'
import { loadOwnedProgram, loadOwnedChild } from '../../../../lib/clientProgramAccess'

// PATCH  /api/client-programs/[id]/notes/[noteId] — body only.
// DELETE /api/client-programs/[id]/notes/[noteId]
//
// VISIBILITY IS IMMUTABLE. Un-sharing does not unsee: a note the client has
// already read cannot be made private again, so offering the edit would promise
// something the product cannot deliver. Retracting is DELETE, which at least
// stops it being read again.
//
// The reverse — coach_only becoming shared — is refused for the matching reason:
// it was written under one audience and the coach cannot re-consent on behalf of
// the version they already wrote. A new note is the way.
export const config = { maxDuration: 30 }

const NOTE_COLUMNS = 'id, program_id, body, visibility, created_at'

type Note = { id: string; program_id: string; body: string; visibility: string; created_at: string }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const noteId = typeof req.query.noteId === 'string' ? req.query.noteId : ''

  try {
    const program = await loadOwnedProgram(userId, id)
    if (!program) return res.status(404).json({ error: 'not_found' })
    const note = await loadOwnedChild<Note>('client_program_notes', NOTE_COLUMNS, noteId, program.id)
    if (!note) return res.status(404).json({ error: 'not_found' })

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('client_program_notes').delete().eq('id', note.id)
      if (error) throw error
      return res.status(200).json({ ok: true, deleted: note.id })
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (key !== 'body') {
        return res.status(400).json({ error: 'invalid_field', field: key, message: key === 'visibility' ? 'visibility is immutable — delete and rewrite' : undefined })
      }
    }
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) return res.status(400).json({ error: 'invalid_field', field: 'body' })

    const { data, error } = await supabase
      .from('client_program_notes')
      .update({ body: text, updated_at: new Date().toISOString() })
      .eq('id', note.id)
      .select(NOTE_COLUMNS)
      .single()
    if (error) throw error
    return res.status(200).json({ note: data })
  } catch (err) {
    console.error('[client-programs/[id]/notes/[noteId]]', err)
    return res.status(500).json({ error: 'Failed to update note' })
  }
}
