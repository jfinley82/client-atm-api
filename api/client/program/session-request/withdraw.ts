import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { loadTokenProgram } from '../../../../lib/clientProgramAccess'

// POST /api/client/program/session-request/withdraw?t=<token> — PUBLIC.
//
// The client takes their own request back. Without this route `withdrawn` is a
// status nothing can ever write, and a client who picked two times they can no
// longer make has to email their coach to unstick themselves — while the partial
// unique index refuses to let them file a corrected one.
//
// NO id IN THE BODY. There is at most one open request per program (the index
// guarantees it), so the token alone names the row. An id would be a second way
// to say the same thing and a second thing to authorize.
export const config = { maxDuration: 30 }

const REQUEST_COLUMNS =
  'id, program_id, item_id, note, preferred_1, preferred_2, status, booking_id, decline_reason, created_at, resolved_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const loaded = await loadTokenProgram(req.query.t)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })
  const program = loaded.program

  try {
    // The status filter is in the WRITE, not in a read before it. A request the
    // coach confirmed a moment ago must not be withdrawn out from under a
    // booking that already exists, and `eq('status','requested')` is what makes
    // that a fact about the update rather than about when the read happened.
    const { data, error } = await supabase
      .from('client_program_session_requests')
      .update({ status: 'withdrawn', resolved_at: new Date().toISOString() })
      .eq('program_id', program.id)
      .eq('status', 'requested')
      .select(REQUEST_COLUMNS)
    if (error) throw error

    const rows = (data || []) as unknown as { id: string }[]
    // Nothing open. Not an error the client caused — but 200 with no row would
    // tell them a withdrawal happened, so it 404s the way a missing thing does.
    if (!rows.length) return res.status(404).json({ error: 'not_found' })

    return res.status(200).json({ request: rows[0] })
  } catch (err) {
    console.error('[client/program/session-request/withdraw]', err)
    return res.status(500).json({ error: 'Failed to withdraw request' })
  }
}
