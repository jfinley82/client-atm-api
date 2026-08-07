import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder } from '../../../../lib/funnels'
import { loadOwnedProgram, loadOwnedChild } from '../../../../lib/clientProgramAccess'
import { sessionsUsed, type ProgramBookingRow } from '../../../../lib/clientProgramSerializers'
import { sendSessionConfirmed, sendSessionDeclined } from '../../../../lib/clientProgramEmail'

// POST /api/client-programs/[id]/requests/[requestId]
//   { action: 'confirm', start_time, end_time } | { action: 'decline', decline_reason? }
//
// One route rather than .../confirm and .../decline as separate files: both
// resolve the SAME open request and both must refuse a request that is no longer
// open. Two files would be two copies of that guard.
export const config = { maxDuration: 30 }

const REQUEST_COLUMNS =
  'id, program_id, item_id, note, preferred_1, preferred_2, status, booking_id, decline_reason, created_at, resolved_at'

type Request = {
  id: string
  program_id: string
  item_id: string | null
  status: 'requested' | 'confirmed' | 'declined' | 'withdrawn'
  booking_id: string | null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : ''

  try {
    const program = await loadOwnedProgram(userId, id)
    if (!program) return res.status(404).json({ error: 'not_found' })
    const request = await loadOwnedChild<Request>('client_program_session_requests', REQUEST_COLUMNS, requestId, program.id)
    if (!request) return res.status(404).json({ error: 'not_found' })

    // A request the client withdrew, or one already resolved, is not actionable.
    // Confirming a withdrawn request would book a call nobody asked for.
    if (request.status !== 'requested') return res.status(409).json({ error: 'not_open', status: request.status })

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const action = body.action

    if (action === 'decline') {
      const reason = typeof body.decline_reason === 'string' ? body.decline_reason.trim() || null : null
      const { data, error } = await supabase
        .from('client_program_session_requests')
        .update({ status: 'declined', decline_reason: reason, resolved_at: new Date().toISOString() })
        .eq('id', request.id)
        .eq('status', 'requested')
        .select(REQUEST_COLUMNS)
      if (error) throw error
      const rows = (data || []) as unknown as Request[]
      if (!rows.length) return res.status(409).json({ error: 'not_open' })
      // Best-effort, after the write. A decline the client never hears about
      // leaves them waiting on a request that has already been answered.
      await sendSessionDeclined(program, reason)
      return res.status(200).json({ request: rows[0] })
    }

    if (action !== 'confirm') return res.status(400).json({ error: 'invalid_field', field: 'action', allowed: ['confirm', 'decline'] })

    const startTime = typeof body.start_time === 'string' ? body.start_time : ''
    const endTime = typeof body.end_time === 'string' ? body.end_time : ''
    if (!isIso(startTime) || !isIso(endTime)) return res.status(400).json({ error: 'invalid_field', field: 'start_time' })
    if (Date.parse(endTime) <= Date.parse(startTime)) return res.status(400).json({ error: 'invalid_field', field: 'end_time' })

    // RE-CHECKED HERE, IMMEDIATELY BEFORE THE WRITE. The check at request time is
    // not sufficient: a second request can be in flight, and a check that
    // happened earlier is not a check that holds now — the same class of mistake
    // as authorizing from a body id. On failure the request stays `requested`, so
    // the coach can see why rather than finding it silently declined.
    const { data: bookingRows, error: bookErr } = await supabase
      .from('bookings')
      .select('id, status, start_time, canceled_at')
      .eq('program_id', program.id)
    if (bookErr) throw bookErr
    const used = sessionsUsed((bookingRows || []) as unknown as ProgramBookingRow[])
    if (used >= program.sessions_allowed) {
      return res.status(409).json({ error: 'no_sessions_remaining', sessions_allowed: program.sessions_allowed, sessions_used: used })
    }

    // THE ONLY PLACE IN THE CODEBASE THAT SETS program_id. It is what
    // structurally excludes discovery calls from the session count: they are not
    // filtered out of the set, they were never in it.
    const { data: booking, error: insertErr } = await supabase
      .from('bookings')
      .insert({
        program_id: program.id,
        coach_user_id: program.user_id,
        name: program.client_name,
        email: program.client_email,
        start_time: startTime,
        end_time: endTime,
        status: 'active',
        timezone: program.client_timezone,
      })
      .select('id, start_time, end_time')
      .single()
    if (insertErr) throw insertErr

    const bookingId = (booking as { id: string }).id

    const { data: resolved, error: updErr } = await supabase
      .from('client_program_session_requests')
      .update({ status: 'confirmed', booking_id: bookingId, resolved_at: new Date().toISOString() })
      .eq('id', request.id)
      .eq('status', 'requested')
      .select(REQUEST_COLUMNS)
    if (updErr) throw updErr

    const rows = (resolved || []) as unknown as Request[]
    if (!rows.length) {
      // Someone resolved it between the read and the write. The booking would
      // otherwise be an orphan consuming a session against a request that no
      // longer points at it.
      await supabase.from('bookings').delete().eq('id', bookingId)
      return res.status(409).json({ error: 'not_open' })
    }

    // The item's title, or null for an ad-hoc call. Read here rather than
    // guessed in the mailer: only this handler knows which item the request
    // named, and a confirmation titled "your call" when the client asked about
    // week 6 reads as a different call.
    let itemTitle: string | null = null
    if (request.item_id) {
      const { data: linked } = await supabase.from('client_program_items').select('title').eq('id', request.item_id).maybeSingle()
      itemTitle = (linked as { title?: string } | null)?.title ?? null
    }
    await sendSessionConfirmed(program, { startIso: startTime, itemTitle })

    return res.status(200).json({ request: rows[0], booking })
  } catch (err) {
    console.error('[client-programs/[id]/requests/[requestId]]', err)
    return res.status(500).json({ error: 'Failed to resolve request' })
  }
}

function isIso(v: string): boolean {
  return !!v && Number.isFinite(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v)
}
