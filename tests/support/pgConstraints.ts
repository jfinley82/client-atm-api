// A fake that can REJECT a write the database would reject.
//
// tests/support/postgrest.ts made the stubs able to withhold columns. They still
// answer yes to every insert, so a handler that violates a UNIQUE index, a CHECK
// or a NOT NULL is green in the suite and fails in production. `record_quiz_result`
// needing to be an upsert is the precedent: the gate was green, the design was
// wrong, and only production had the UNIQUE(user_id) that proved it.
//
// The rule this exists to enforce: A MOCK SHOULD BE ABLE TO ANSWER WRONGLY.
// A fake that cannot fail cannot test the guard against failing.
//
// Constraints are declared from the real migration, not invented. Anything
// declared here should be checkable against supabase/migrations/095 by reading
// both — and tests/clientProgramWrites.test.ts asserts exactly that, so a CHECK
// widened in SQL and forgotten here fails the gate.

export type PgError = { code: string; message: string; details: string | null; hint: string | null }

export type TableConstraints = {
  /**
   * Column defaults, applied BEFORE the checks — because that is the order
   * Postgres uses. A NOT NULL column with a default is satisfied by an insert
   * that omits it, and a fake that checks first would refuse a legal write.
   *
   * Modelling these is not decoration: `portal_token_version integer not null
   * default 1` means a freshly created program reads 1, and a fake that returns
   * undefined makes `version + 1` NaN in a handler that is correct.
   */
  defaults?: Record<string, unknown>
  /** Columns that may not be null or absent on insert. */
  notNull?: string[]
  /** column -> the permitted value set, mirroring a text + CHECK column. */
  check?: Record<string, readonly string[]>
  /** Numeric bounds, mirroring `check (col between lo and hi)`. */
  range?: Record<string, [number, number]>
  /**
   * Unique indexes. `where` makes it PARTIAL, which is the only kind that can be
   * satisfied twice — one open session request per program is legal precisely
   * because the resolved ones fall outside the predicate.
   */
  unique?: { columns: string[]; where?: (row: Record<string, any>) => boolean }[]
  /** column -> the table it points at. A dangling reference is a 23503. */
  foreignKeys?: Record<string, string>
}

// Real PostgreSQL SQLSTATEs, because handlers branch on them. A fake that
// invented its own code would let a handler match on the wrong one and still
// pass here — 23505 is the unique violation api/admin/courses already keys on.
export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'
export const PG_NOT_NULL_VIOLATION = '23502'
export const PG_FOREIGN_KEY_VIOLATION = '23503'

function err(code: string, message: string): PgError {
  return { code, message, details: null, hint: null }
}

/** Fill in what the schema would fill in. Returns a new row; never mutates. */
export function applyDefaults(row: Record<string, any>, constraints: TableConstraints | undefined): Record<string, any> {
  if (!constraints?.defaults) return row
  const out = { ...row }
  for (const [col, value] of Object.entries(constraints.defaults)) {
    if (out[col] === undefined) out[col] = value
  }
  return out
}

/**
 * Validate one row against a table's declared constraints.
 *
 * Returns the PostgREST-shaped error the real thing would return, or null when
 * the write is legal. Callers hand it back with a non-2xx status, which
 * tests/support/postgrest.ts deliberately does not project — an error body is
 * not a row and `select=` says nothing about its shape.
 */
export function checkWrite(
  table: string,
  row: Record<string, any>,
  constraints: TableConstraints,
  existingRows: Record<string, any>[],
  allTables: Record<string, Record<string, any>[]> = {}
): PgError | null {
  for (const col of constraints.notNull || []) {
    if (row[col] === null || row[col] === undefined) {
      return err(PG_NOT_NULL_VIOLATION, `null value in column "${col}" of relation "${table}" violates not-null constraint`)
    }
  }

  for (const [col, allowed] of Object.entries(constraints.check || {})) {
    const v = row[col]
    // A CHECK constrains the values that ARE there. `canceled_by is null or in
    // (...)` permits null, and a fake that rejected it would fail a legal write.
    if (v === null || v === undefined) continue
    if (!allowed.includes(v)) {
      return err(PG_CHECK_VIOLATION, `new row for relation "${table}" violates check constraint on "${col}" (got ${JSON.stringify(v)})`)
    }
  }

  for (const [col, [lo, hi]] of Object.entries(constraints.range || {})) {
    const v = row[col]
    if (v === null || v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      return err(PG_CHECK_VIOLATION, `new row for relation "${table}" violates check constraint on "${col}" (got ${JSON.stringify(v)}, want ${lo}..${hi})`)
    }
  }

  for (const [col, target] of Object.entries(constraints.foreignKeys || {})) {
    const v = row[col]
    if (v === null || v === undefined) continue
    const parent = allTables[target]
    // Unmodelled parent tables are not treated as empty — that would turn every
    // FK into a failure and make the fake reject legal writes.
    if (!parent) continue
    if (!parent.some((r) => r.id === v)) {
      return err(PG_FOREIGN_KEY_VIOLATION, `insert or update on table "${table}" violates foreign key constraint on "${col}"`)
    }
  }

  for (const idx of constraints.unique || []) {
    // A partial index only constrains rows its predicate accepts. Applied to the
    // INCOMING row too: a second `declined` request is legal beside an open one
    // precisely because neither the new row nor the old one is inside the
    // predicate together.
    if (idx.where && !idx.where(row)) continue
    const clash = existingRows.some((r) => {
      if (r.id && row.id && r.id === row.id) return false // updating itself
      if (idx.where && !idx.where(r)) return false
      // NULL IS NOT EQUAL TO NULL in a unique index — two rows with a null
      // lead_id do not collide, which is what lets a coach add any number of
      // clients by hand.
      return idx.columns.every((c) => r[c] !== null && r[c] !== undefined && r[c] === row[c])
    })
    if (clash) {
      return err(PG_UNIQUE_VIOLATION, `duplicate key value violates unique constraint on (${idx.columns.join(', ')})`)
    }
  }

  return null
}

/**
 * The 095 constraints, declared from the migration.
 *
 * Kept next to the checker rather than inside one test file so every write test
 * enforces the same schema — the drift this repo has been bitten by is two
 * copies of one rule, not one rule being wrong.
 */
export const CLIENT_PROGRAM_CONSTRAINTS: Record<string, TableConstraints> = {
  client_programs: {
    defaults: { status: 'draft', sessions_allowed: 0, portal_token_version: 1, lead_id: null, client_timezone: null, portal_last_opened_at: null, activated_at: null, completed_at: null },
    notNull: ['user_id', 'client_name', 'client_email', 'program_snapshot', 'program_name', 'total_weeks', 'start_date'],
    check: { status: ['draft', 'active', 'completed', 'paused', 'canceled'] },
    range: { total_weeks: [1, 16], sessions_allowed: [0, 200] },
    unique: [{ columns: ['user_id', 'lead_id'], where: (r) => r.lead_id !== null && r.lead_id !== undefined }],
    foreignKeys: { user_id: 'users', lead_id: 'funnel_leads' },
  },
  client_program_items: {
    defaults: { sort_order: 0, due_date_source: 'derived', status: 'pending', source_week: null, detail: null, phase_name: null, due_date: null, completed_at: null, completed_by: null, reminder_message_id: null },
    notNull: ['program_id', 'kind', 'sequence_position', 'title'],
    check: {
      kind: ['week', 'task', 'milestone'],
      status: ['pending', 'completed'],
      due_date_source: ['derived', 'manual'],
      completed_by: ['coach', 'client'],
    },
    range: { sequence_position: [1, Number.MAX_SAFE_INTEGER], source_week: [1, Number.MAX_SAFE_INTEGER] },
    foreignKeys: { program_id: 'client_programs' },
  },
  client_program_notes: {
    notNull: ['program_id', 'body', 'visibility'],
    check: { visibility: ['coach_only', 'coach_and_client'] },
    foreignKeys: { program_id: 'client_programs' },
  },
  client_program_session_requests: {
    defaults: { status: 'requested', item_id: null, note: null, preferred_1: null, preferred_2: null, booking_id: null, decline_reason: null, resolved_at: null },
    notNull: ['program_id'],
    check: { status: ['requested', 'confirmed', 'declined', 'withdrawn'] },
    unique: [{ columns: ['program_id'], where: (r) => r.status === 'requested' || r.status === undefined }],
    foreignKeys: { program_id: 'client_programs', item_id: 'client_program_items', booking_id: 'bookings' },
  },
}
