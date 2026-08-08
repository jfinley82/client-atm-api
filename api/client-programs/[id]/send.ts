import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'
import type { ProgramRow } from '../../../lib/clientProgramSerializers'
import { sendProgramWelcome, syncAllReminders } from '../../../lib/clientProgramEmail'

// POST /api/client-programs/[id]/send — draft -> active.
//
// THE ONLY DOOR, AND IT IS ONE-WAY. PATCH refuses `draft` in either direction
// precisely so this transition cannot happen without whatever it carries; there
// is no active -> draft, because once the client holds the link, un-sending it
// is a fiction.
//
// Idempotent by refusal rather than by repetition: a second call on an already
// active program is 409 not_draft, not a second activation with a second
// activated_at. The stamp is the moment the client got access and must not move.
export const config = { maxDuration: 30 }

const PROGRAM_COLUMNS =
  'id, user_id, lead_id, client_name, client_email, client_timezone, program_name, total_weeks, sessions_allowed, start_date, status, portal_token_version, portal_last_opened_at, activated_at, completed_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const { data: existing } = await supabase.from('client_programs').select(PROGRAM_COLUMNS).eq('id', id).maybeSingle()
    if (!existing || (existing as unknown as ProgramRow).user_id !== userId) return res.status(404).json({ error: 'not_found' })
    const program = existing as unknown as ProgramRow

    if (program.status !== 'draft') return res.status(409).json({ error: 'not_draft', status: program.status })

    // .eq('status','draft') in the UPDATE, not only in the check above. Two
    // concurrent sends both read `draft`; only one may write it. The second
    // updates zero rows and is told so, rather than stamping activated_at twice.
    const activatedAt = new Date().toISOString()
    const { data: updated, error } = await supabase
      .from('client_programs')
      .update({ status: 'active', activated_at: activatedAt, updated_at: activatedAt })
      .eq('id', program.id)
      .eq('status', 'draft')
      .select(PROGRAM_COLUMNS)
    if (error) throw error

    const rows = (updated || []) as unknown as ProgramRow[]
    if (!rows.length) return res.status(409).json({ error: 'not_draft', status: 'active' })

    // THE STATE CHANGE IS ALREADY COMMITTED. Both of these are best-effort by
    // contract and neither may fail the response: a programme that is active with
    // an unsent welcome is recoverable (the coach resends the link), while a
    // programme that 500s after flipping to active leaves the coach believing it
    // is still a draft when the client can already open it.
    //
    // Reminders are scheduled HERE rather than at item creation, because until
    // this moment there was nothing to remind anyone about — wantsReminder
    // refuses a draft, so an item created earlier deliberately queued nothing.
    const active = rows[0]
    await sendProgramWelcome(active)
    await syncAllReminders(active)

    return res.status(200).json({ program: active })
  } catch (err) {
    console.error('[client-programs/[id]/send]', err)
    return res.status(500).json({ error: 'Failed to send program' })
  }
}
