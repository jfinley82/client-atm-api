import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { loadTokenProgram, loadOwnedChild } from '../../../lib/clientProgramAccess'
import { sessionsUsed, type ProgramBookingRow } from '../../../lib/clientProgramSerializers'
import { notifyCoachSessionRequested } from '../../../lib/clientProgramEmail'

// POST /api/client/program/session-request?t=<token> — PUBLIC.
// Body { item_id?, note?, preferred_1?, preferred_2? }.
//
// The client asks for a call; the coach confirms it against a real time. Nothing
// here books anything — creating the booking is the coach's endpoint, which
// re-checks the allowance immediately before the write because this check does
// not hold once a second request is in flight.
export const config = { maxDuration: 30 }

const REQUEST_COLUMNS =
  'id, program_id, item_id, note, preferred_1, preferred_2, status, booking_id, decline_reason, created_at, resolved_at'

const PG_UNIQUE_VIOLATION = '23505'
const MAX_NOTE = 2000
const MAX_PREFERRED = 200

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const loaded = await loadTokenProgram(req.query.t)
  if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error })
  const program = loaded.program

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  try {
    // A milestone the client can point at — "the week 6 check-in" rather than
    // "a call". Optional, because an ad-hoc call is a legitimate ask.
    let itemId: string | null = null
    if (body.item_id !== undefined && body.item_id !== null) {
      if (typeof body.item_id !== 'string') return res.status(400).json({ error: 'invalid_item' })
      // CHECKED THE SAME WAY ITEM COMPLETION IS. The token names one program, so
      // an item id from the body has to prove it belongs to that program before
      // it is stored — otherwise a request row would carry a foreign item and
      // the coach's confirm screen would render someone else's milestone.
      const item = await loadOwnedChild<{ id: string; program_id: string; kind: string }>(
        'client_program_items',
        'id, program_id, kind',
        body.item_id,
        program.id
      )
      // A task or a week heading is not a call. Only a milestone has a session
      // behind it, and §8.3's title/time join reads item_id expecting one.
      if (!item || item.kind !== 'milestone') return res.status(400).json({ error: 'invalid_item' })
      itemId = item.id
    }

    // THE ALLOWANCE, COUNTED BY program_id AND NOTHING ELSE. Discovery calls
    // this client had with this coach before the program carry a null program_id
    // and are structurally outside this set.
    const { data: bookingRows, error: bookErr } = await supabase
      .from('bookings')
      .select('id, status, start_time, canceled_at')
      .eq('program_id', program.id)
    if (bookErr) throw bookErr
    const used = sessionsUsed((bookingRows || []) as unknown as ProgramBookingRow[])
    if (used >= program.sessions_allowed) {
      return res.status(409).json({ error: 'no_sessions_remaining', sessions_allowed: program.sessions_allowed, sessions_used: used })
    }

    const insert = {
      program_id: program.id,
      item_id: itemId,
      note: text(body.note, MAX_NOTE),
      preferred_1: text(body.preferred_1, MAX_PREFERRED),
      preferred_2: text(body.preferred_2, MAX_PREFERRED),
      status: 'requested',
    }

    const { data, error } = await supabase.from('client_program_session_requests').insert(insert).select(REQUEST_COLUMNS).single()
    if (error) {
      // ONE OPEN REQUEST AT A TIME, AND THE INDEX SAYS SO — uq_session_request_open
      // is partial on status='requested'. Answered from the violation rather
      // than from a pre-read, because a pre-read cannot see a request filed a
      // millisecond ago and two open rows is a state the coach's screen has no
      // way to render.
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'request_already_open' })
      }
      throw error
    }

    // THE COACH IS THE ONE WHO HAS TO ACT. Best-effort and MTM-branded — this is
    // our product telling a member something happened in it, not their business
    // writing to them in their own name.
    let itemTitle: string | null = null
    if (itemId) {
      const { data: linked } = await supabase.from('client_program_items').select('title').eq('id', itemId).maybeSingle()
      itemTitle = (linked as { title?: string } | null)?.title ?? null
    }
    await notifyCoachSessionRequested(program, {
      note: insert.note,
      preferred_1: insert.preferred_1,
      preferred_2: insert.preferred_2,
      itemTitle,
    })

    return res.status(201).json({ request: data })
  } catch (err) {
    console.error('[client/program/session-request]', err)
    return res.status(500).json({ error: 'Failed to file request' })
  }
}

// Trimmed, capped, and null when empty. A blank string and "not supplied" are
// the same fact here and must not be stored as two.
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed ? trimmed.slice(0, max) : null
}
