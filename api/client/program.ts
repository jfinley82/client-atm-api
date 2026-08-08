import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { loadTokenProgram } from '../../lib/clientProgramAccess'
import { loadPortalBrand } from '../../lib/clientProgramPortal'
import {
  serializeClientPortal,
  type ItemRow,
  type NoteRow,
  type SessionRequestRow,
  type ProgramBookingRow,
} from '../../lib/clientProgramSerializers'

// GET /api/client/program?t=<token> — PUBLIC. The client's whole portal, in one
// call, with no session and no account.
//
// The token is the credential and it names ONE program (lib/clientProgramAccess
// carries the four checks). Everything below is scoped by `program.id` and
// nothing else — there is no caller identity to scope by, which is exactly why
// every query here reads program_id and none of them reads an id from the query
// string.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const loaded = await loadTokenProgram(req.query.t)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })
  const program = loaded.program

  try {
    const [itemsRes, notesRes, requestsRes, bookingsRes, coach] = await Promise.all([
      supabase
        .from('client_program_items')
        .select('id, kind, sequence_position, source_week, sort_order, title, detail, phase_name, due_date, status, completed_at, completed_by')
        .eq('program_id', program.id)
        .order('sequence_position', { ascending: true }),
      // STOP SELECTING, DON'T STOP USING. The visibility filter is in the QUERY,
      // so a coach_only note is never in this process's memory at all. Filtering
      // it out after the fact would work identically until the day someone adds
      // a second consumer of the same variable.
      supabase
        .from('client_program_notes')
        .select('id, body, visibility, created_at')
        .eq('program_id', program.id)
        .eq('visibility', 'coach_and_client')
        .order('created_at', { ascending: false }),
      supabase
        .from('client_program_session_requests')
        .select('id, item_id, note, preferred_1, preferred_2, status, booking_id, decline_reason, created_at, resolved_at')
        .eq('program_id', program.id)
        .order('created_at', { ascending: false }),
      // sessions_used counts BY program_id and nothing else. A discovery call
      // this client had with this coach before the program carries a null
      // program_id, so it is not excluded from this set — it was never in it.
      supabase.from('bookings').select('id, status, start_time, end_time, canceled_at').eq('program_id', program.id),
      loadPortalBrand(program.user_id),
    ])
    if (itemsRes.error) throw itemsRes.error
    if (notesRes.error) throw notesRes.error
    if (requestsRes.error) throw requestsRes.error
    if (bookingsRes.error) throw bookingsRes.error

    const bookings = (bookingsRes.data || []) as unknown as (ProgramBookingRow & { end_time: string | null })[]
    const byBooking = new Map(bookings.map((b) => [b.id, b]))
    const sessionRequests = ((requestsRes.data || []) as unknown as (SessionRequestRow & { booking_id: string | null })[]).map((r) => {
      const b = r.booking_id ? byBooking.get(r.booking_id) : undefined
      return { ...r, booking: b ? { start_time: b.start_time, end_time: b.end_time ?? null } : null }
    })

    const payload = serializeClientPortal({
      program,
      items: (itemsRes.data || []) as unknown as ItemRow[],
      bookings,
      notes: (notesRes.data || []) as unknown as NoteRow[],
      sessionRequests: sessionRequests as unknown as SessionRequestRow[],
      today: new Date().toISOString().slice(0, 10),
      coachFirstName: coach.coachFirstName,
      brand: coach.brand,
    })

    // FIRE AND FORGET. "When did they last look" is a nice-to-have for the coach
    // list; the client seeing their program is not. Neither the latency nor a
    // failure of this write may reach the response, so it is not awaited and its
    // rejection is swallowed with a log.
    void supabase
      .from('client_programs')
      .update({ portal_last_opened_at: new Date().toISOString() })
      .eq('id', program.id)
      .then(({ error }) => {
        if (error) console.error('[client/program] portal_last_opened_at', error)
      })

    return res.status(200).json(payload)
  } catch (err) {
    console.error('[client/program]', err)
    return res.status(500).json({ error: 'Failed to load program' })
  }
}
