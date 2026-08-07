import { supabase } from './supabase'
import type { ProgramRow } from './clientProgramSerializers'

// ONE OWNERSHIP CHECK for every client-program route.
//
// Eight endpoints now reach a program by id out of the URL, and each one is a
// place the check could be written slightly differently or forgotten entirely.
// RLS is off on these tables, so this IS the access control.
//
// A program on someone else's account 404s exactly like one that does not
// exist — the same "indistinguishable from missing" stance getOwnedFunnel takes.
// A 403 would confirm the id is real to someone who guessed it.

export const PROGRAM_COLUMNS =
  'id, user_id, lead_id, client_name, client_email, client_timezone, program_name, total_weeks, sessions_allowed, start_date, status, portal_token_version, portal_last_opened_at, activated_at, completed_at'

export const ITEM_COLUMNS =
  'id, program_id, kind, sequence_position, source_week, sort_order, title, detail, phase_name, due_date, due_date_source, status, completed_at, completed_by, reminder_message_id'

export async function loadOwnedProgram(userId: string, programId: string): Promise<ProgramRow | null> {
  if (!programId) return null
  const { data } = await supabase.from('client_programs').select(PROGRAM_COLUMNS).eq('id', programId).maybeSingle()
  if (!data) return null
  const program = data as unknown as ProgramRow
  return program.user_id === userId ? program : null
}

/**
 * A child row of a program the caller owns.
 *
 * TWO CHECKS, NOT ONE. The child is fetched by its own id and then required to
 * belong to THIS program — a note id from another coach's program would
 * otherwise be editable by anyone who could name it, because the program in the
 * URL is the only thing being authorized. Same shape as the item-completion
 * rule: the parent authorizes, the child must prove it belongs to that parent.
 */
export async function loadOwnedChild<T extends { program_id?: string }>(
  table: string,
  columns: string,
  childId: string,
  programId: string
): Promise<T | null> {
  if (!childId) return null
  const { data } = await supabase.from(table).select(columns).eq('id', childId).maybeSingle()
  if (!data) return null
  const row = data as unknown as T
  return row.program_id === programId ? row : null
}
