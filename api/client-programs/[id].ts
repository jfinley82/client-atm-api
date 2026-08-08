import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { redriveDueDates, isValidStartDate } from '../../lib/clientProgramPlan'
import { serializeProgramDetail, type ProgramRow, type ItemRow, type NoteRow, type SessionRequestRow, type ProgramBookingRow } from '../../lib/clientProgramSerializers'
import { programPortalUrl } from '../../lib/clientProgramPortal'
import { syncAllReminders, syncChangedReminders, type ReminderItem } from '../../lib/clientProgramEmail'

// GET    /api/client-programs/[id] — the whole programme, in one call.
// PATCH  /api/client-programs/[id] — edit a program.
// DELETE /api/client-programs/[id] — discard a DRAFT.
export const config = { maxDuration: 30 }

const PROGRAM_COLUMNS =
  'id, user_id, lead_id, client_name, client_email, client_timezone, program_name, total_weeks, sessions_allowed, start_date, status, portal_token_version, portal_last_opened_at, activated_at, completed_at'

// The ONLY keys a PATCH may carry. An allowlist rather than a denylist: a column
// added to client_programs later is not editable by accident, which is the
// direction that fails safe.
const PATCHABLE = new Set([
  'status',
  'start_date',
  'client_name',
  'client_email',
  'client_timezone',
  'sessions_allowed',
  'revoke_portal_link',
])

// PATCH may not touch `draft` in either direction.
//
// draft -> active here would activate a program without program_welcome being
// sent or reminders scheduled, and the client would never learn it exists. The
// reverse is worse: un-drafting a program the client already holds a link to
// pretends it was never sent. POST .../send is the one door, and it is one-way.
const TERMINAL_FROM_ANY = 'canceled'
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'completed', TERMINAL_FROM_ANY],
  paused: ['active', TERMINAL_FROM_ANY],
  completed: [TERMINAL_FROM_ANY],
  canceled: [TERMINAL_FROM_ANY],
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const { data: existing } = await supabase.from('client_programs').select(PROGRAM_COLUMNS).eq('id', id).maybeSingle()
    // OWNERSHIP FIRST, and a program on someone else's account 404s exactly like
    // one that does not exist — the same "indistinguishable from missing" stance
    // the rest of this codebase takes.
    if (!existing || (existing as unknown as ProgramRow).user_id !== userId) {
      return res.status(404).json({ error: 'not_found' })
    }
    const program = existing as unknown as ProgramRow

    if (req.method === 'GET') return getProgram(res, program)
    if (req.method === 'DELETE') return deleteProgram(res, program)
    return patchProgram(req, res, program)
  } catch (err) {
    console.error('[client-programs/[id]]', err)
    return res.status(500).json({ error: 'Failed to update program' })
  }
}

/**
 * ONE CALL for the whole programme — items, notes and session requests together.
 *
 * Built through serializeProgramDetail so the shape is the one
 * docs/served-contract.md was generated from; a second hand-rolled response here
 * would be a second contract nobody regenerates.
 */
async function getProgram(res: VercelResponse, program: ProgramRow) {
  const [itemsRes, notesRes, requestsRes, bookingsRes] = await Promise.all([
    supabase
      .from('client_program_items')
      .select('id, kind, sequence_position, source_week, sort_order, title, detail, phase_name, due_date, status, completed_at, completed_by')
      .eq('program_id', program.id)
      .order('sequence_position', { ascending: true }),
    supabase
      .from('client_program_notes')
      .select('id, body, visibility, created_at')
      .eq('program_id', program.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('client_program_session_requests')
      .select('id, item_id, note, preferred_1, preferred_2, status, booking_id, decline_reason, created_at, resolved_at')
      .eq('program_id', program.id)
      .order('created_at', { ascending: false }),
    supabase.from('bookings').select('id, status, start_time, end_time, canceled_at').eq('program_id', program.id),
  ])
  if (itemsRes.error) throw itemsRes.error
  if (notesRes.error) throw notesRes.error
  if (requestsRes.error) throw requestsRes.error
  if (bookingsRes.error) throw bookingsRes.error

  const bookings = (bookingsRes.data || []) as unknown as (ProgramBookingRow & { end_time: string | null })[]
  const byBooking = new Map(bookings.map((b) => [b.id, b]))

  // due_date is a `date` and carries no time of day, so a confirmed call's
  // instant lives on the booking. This join is the only way to render
  // "Week 6 check-in call, Thursday 2:00pm" rather than a bare date.
  const sessionRequests = ((requestsRes.data || []) as unknown as (SessionRequestRow & { booking_id: string | null })[]).map((r) => {
    const b = r.booking_id ? byBooking.get(r.booking_id) : undefined
    return { ...r, booking: b ? { start_time: b.start_time, end_time: b.end_time ?? null } : null }
  })

  // DISPLAY ONLY, and the comment on ProgramDetailInput.discoveryCallCount says
  // why: this is the (coach, email) match the schema calls a trap, and it must
  // never reach the allowance, which counts by program_id and nothing else.
  const { count: discoveryCallCount } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('coach_user_id', program.user_id)
    .ilike('email', program.client_email)
    .is('program_id', null)

  const portalUrl = programPortalUrl(program)

  return res.status(200).json(
    serializeProgramDetail({
      program,
      items: (itemsRes.data || []) as unknown as ItemRow[],
      bookings,
      openSessionRequests: sessionRequests.filter((r) => r.status === 'requested').length,
      today: new Date().toISOString().slice(0, 10),
      notes: (notesRes.data || []) as unknown as NoteRow[],
      sessionRequests: sessionRequests as unknown as SessionRequestRow[],
      portalUrl,
      discoveryCallCount: discoveryCallCount ?? 0,
    })
  )
}

/**
 * A DRAFT IS DISCARDABLE. An active program never is.
 *
 * uq_client_programs_lead does not filter on status, so a draft permanently
 * holds its lead out of eligible-leads. A coach who opens the preview, changes
 * their mind and backs out would otherwise burn that lead with no way to recover
 * it. An active program is `canceled` instead, and the client's history stays.
 */
async function deleteProgram(res: VercelResponse, program: ProgramRow) {
  if (program.status !== 'draft') return res.status(409).json({ error: 'not_draft' })
  // Items, notes and requests go with it — 095 cascades them from the program.
  const { error } = await supabase.from('client_programs').delete().eq('id', program.id)
  if (error) throw error
  return res.status(200).json({ ok: true, deleted: program.id })
}

async function patchProgram(req: VercelRequest, res: VercelResponse, program: ProgramRow) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  for (const key of Object.keys(body)) {
    if (!PATCHABLE.has(key)) return res.status(400).json({ error: 'invalid_field', field: key })
  }

  const updates: Record<string, unknown> = {}

  if ('status' in body) {
    const next = body.status
    if (typeof next !== 'string') return res.status(400).json({ error: 'invalid_field', field: 'status' })
    // Either direction. `draft` is POST .../send's alone.
    if (next === 'draft' || program.status === 'draft') return res.status(400).json({ error: 'use_send_endpoint' })
    if (!(ALLOWED_TRANSITIONS[program.status] || []).includes(next)) {
      return res.status(400).json({ error: 'invalid_transition', from: program.status, to: next })
    }
    updates.status = next
    // Stamped here rather than derived, because "when did this finish" has no
    // other signal — completed_at is the only record of the moment.
    if (next === 'completed') updates.completed_at = new Date().toISOString()
  }

  if ('start_date' in body) {
    if (!isValidStartDate(body.start_date)) return res.status(400).json({ error: 'invalid_start_date' })
    updates.start_date = body.start_date
  }

  for (const key of ['client_name', 'client_email'] as const) {
    if (key in body) {
      const v = body[key]
      if (typeof v !== 'string' || !v.trim()) return res.status(400).json({ error: 'invalid_field', field: key })
      updates[key] = v.trim()
    }
  }

  if ('client_timezone' in body) {
    const v = body.client_timezone
    // Null is meaningful: it means we do not know their zone, and the reader
    // substitutes UTC. Clearing it back to unknown has to be possible.
    if (v === null) updates.client_timezone = null
    else if (typeof v === 'string' && v.trim()) updates.client_timezone = v.trim()
    else return res.status(400).json({ error: 'invalid_field', field: 'client_timezone' })
  }

  if ('sessions_allowed' in body) {
    const n = Math.round(Number(body.sessions_allowed))
    if (!Number.isFinite(n) || n < 0 || n > 200) return res.status(400).json({ error: 'invalid_field', field: 'sessions_allowed' })
    updates.sessions_allowed = n
  }

  if (body.revoke_portal_link === true) {
    // Kills every link ever issued for this program, immediately. The token
    // carries the version it was signed with, so the bump is the revocation —
    // there is nothing to delete and nothing to expire.
    updates.portal_token_version = program.portal_token_version + 1
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_changes' })

  updates.updated_at = new Date().toISOString()

  const { data: updated, error } = await supabase
    .from('client_programs')
    .update(updates)
    .eq('id', program.id)
    .select(PROGRAM_COLUMNS)
    .single()
  if (error) throw error

  // MOVING start_date RE-DERIVES DATES, and only on rows the coach did not set
  // by hand. A date they typed is a decision; recomputing it silently overwrites
  // that decision with no way to tell which ones were theirs.
  // THE QUEUE FOLLOWS THE ROW, and the two edits that reach it are different
  // shapes. Re-synced from the UPDATED row in both cases, because the decision
  // "may this programme mail anyone" reads program.status.
  const next = updated as unknown as ProgramRow

  // A moved start_date re-derives dates on the rows the coach did not set by
  // hand, so only those rows' reminders move — a manual date survives the move
  // and so does the reminder built from it.
  if ('start_date' in updates) {
    const changed = await redriveProgramDates(program.id, updates.start_date as string)
    await syncChangedReminders(next, changed.before, changed.after)
  }

  // A status change decides whether this programme may mail at all, so it is
  // every row or none. Paused must go quiet: a client told their programme is on
  // hold and then nudged about a task the next morning has been told two
  // different things by the same system.
  if ('status' in updates) {
    await syncAllReminders(next)
  }

  return res.status(200).json({ program: updated })
}

/**
 * Returns what moved, so the caller can re-queue exactly those reminders.
 *
 * The before/after pair rather than a boolean: a reminder is keyed on the due
 * date, so "which dates changed" is the only question the queue needs answered,
 * and computing it twice — once here and once from a re-read — is how the two
 * answers start disagreeing.
 */
async function redriveProgramDates(
  programId: string,
  startDate: string
): Promise<{ before: Array<{ id: string; due_date: string | null }>; after: ReminderItem[] }> {
  const { data: items, error } = await supabase
    .from('client_program_items')
    .select('id, kind, title, sequence_position, due_date, due_date_source, status, reminder_message_id')
    .eq('program_id', programId)
  if (error) {
    console.error('[client-programs/[id]] could not re-derive due dates', error)
    return { before: [], after: [] }
  }
  const rows = (items || []) as unknown as (ReminderItem & { sequence_position: number; due_date_source: 'derived' | 'manual' })[]
  const before = rows.map((r) => ({ id: r.id, due_date: r.due_date }))

  // Only rows whose date actually moves, and only derived ones. A no-op update
  // per item would rewrite updated_at across the whole plan for nothing.
  const redriven = redriveDueDates(rows, startDate)
  const after: ReminderItem[] = []
  for (let n = 0; n < redriven.length; n++) {
    const r = redriven[n]
    after.push({ ...rows[n], due_date: r.due_date })
    if (r.due_date === rows[n].due_date) continue
    // `week` rows carry a null derived date and stay null; nothing here special-
    // cases them because derivedDueDate is keyed on position, not on kind.
    await supabase.from('client_program_items').update({ due_date: r.due_date }).eq('id', r.id)
  }
  return { before, after }
}
