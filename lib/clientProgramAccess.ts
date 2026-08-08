import { supabase } from './supabase'
import type { ProgramRow } from './clientProgramSerializers'
import { verifyProgramToken } from './funnelLeadToken'

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
/**
 * THE CLIENT'S SIDE OF THE SAME QUESTION.
 *
 * `api/client/**` has no session and no user id — the token IS the credential,
 * and it names exactly one program. Every client route resolves it here so the
 * four checks below cannot be spelled differently in four files:
 *
 * 1. The signature verifies and the token has not expired  -> otherwise 401.
 * 2. A program with that id exists.
 * 3. Its `portal_token_version` still equals the version in the payload. This
 *    is the revocation: bumping the column invalidates every link ever mailed,
 *    including one captured out of an email months ago.
 * 4. Its status is `active`. A draft was never sent; a canceled program is not
 *    the client's any more.
 *
 * 2, 3 and 4 all answer 404, deliberately and identically. A 403 on a stale
 * token would confirm the program is real to whoever presented it, and
 * distinguishing "revoked" from "never existed" tells an attacker which ids to
 * keep trying.
 *
 * A verified token is NOT authorization on its own — it names a program, so a
 * child row reached through it must still prove it belongs to that program.
 * `loadOwnedChild` does that half, with the token's programId as the parent.
 */
export type TokenLoad = { ok: true; program: ProgramRow } | { ok: false; status: 401 | 404; error: string }

export async function loadTokenProgram(token: unknown): Promise<TokenLoad> {
  const claim = verifyProgramToken(token)
  if (!claim) return { ok: false, status: 401, error: 'invalid_token' }

  const { data } = await supabase.from('client_programs').select(PROGRAM_COLUMNS).eq('id', claim.programId).maybeSingle()
  if (!data) return { ok: false, status: 404, error: 'not_found' }
  const program = data as unknown as ProgramRow

  if (program.portal_token_version !== claim.version) return { ok: false, status: 404, error: 'not_found' }
  if (program.status !== 'active') return { ok: false, status: 404, error: 'not_found' }
  return { ok: true, program }
}

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
