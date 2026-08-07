// 095_client_programs.sql — the shape of the Client Programs schema, asserted
// against the code that has to live inside it.
//
// The load-bearing test here is NOT "the file contains the words we expect".
// It is that the total_weeks CHECK and lib/programReshape.ts's MIN_WEEKS/
// MAX_WEEKS agree with EACH OTHER. Those two artifacts decide the same
// question — how long may a program be — from opposite sides, and nothing but
// memory keeps them aligned. If the CHECK is narrower than the code, a coach
// reshapes to a legal length and the database refuses the create; the failure
// lands on a real client, at create time, having passed every local check.
//
// Same shape as tests/ctaSeam.test.ts comparing the VML and anchor branches
// against each other rather than against constants.

import { readFileSync, readdirSync } from 'fs'
import { MIN_WEEKS, MAX_WEEKS } from '../lib/programReshape'

let pass = 0,
  fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++
    console.log('  PASS', label)
  } else {
    fail++
    console.log('  FAIL', label, extra ? '\n      ' + extra : '')
  }
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const DIR = 'supabase/migrations'
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()

const raw095 = readFileSync(`${DIR}/095_client_programs.sql`, 'utf8')
const raw094 = readFileSync(`${DIR}/094_booking_cancellation_provenance.sql`, 'utf8')

// Comments explain intent and legitimately mention things the DDL must not do
// ("could not live in 094", "never filter to exclude discovery calls"). Every
// structural assertion below reads the STRIPPED sql, so a comment can never
// satisfy — or break — a claim about the schema.
const strip = (s: string) => s.replace(/--[^\n]*/g, '')
const sql = strip(raw095)
const sql094 = strip(raw094)

console.log('\n-- numbering: 095 is next, and alone --')
{
  eq('exactly one 095', files.filter((f) => f.startsWith('095_')).length, 1)
  eq('exactly one 094', files.filter((f) => f.startsWith('094_')).length, 1)
  // Derived from the directory, never a literal: a hardcoded count above a
  // table of a different size is one of this repo's recorded defects.
  const highest = files[files.length - 1]
  eq('095 is the highest-numbered migration', highest, '095_client_programs.sql')
}

console.log('\n-- the two artifacts that decide program length must agree --')
{
  // Read the bound OUT of the SQL rather than asserting a number we also wrote
  // in the SQL. The predicate is written independently of the file it checks.
  const m = /total_weeks\s+integer\s+not\s+null\s+check\s*\(\s*total_weeks\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i.exec(sql)
  ok('the total_weeks CHECK is present and parseable', m !== null, 'no `check (total_weeks between N and M)` found')
  const lo = m ? Number(m[1]) : NaN
  const hi = m ? Number(m[2]) : NaN

  // THE PROPERTY. Not "the CHECK says 1 and 16" — that would pass happily after
  // someone widens MAX_WEEKS and forgets the schema. The database must accept
  // every length lib/programReshape.ts is willing to produce, and no more.
  eq('the CHECK floor equals MIN_WEEKS from lib/programReshape.ts', lo, MIN_WEEKS)
  eq('the CHECK ceiling equals MAX_WEEKS from lib/programReshape.ts', hi, MAX_WEEKS)

  // Stated separately so a failure names the direction. A schema NARROWER than
  // the code rejects a legal program; WIDER lets a program exist that no code
  // path can reshape. They are different bugs with different fixes.
  ok('the schema refuses nothing the reshaper permits', lo <= MIN_WEEKS && hi >= MAX_WEEKS, `schema ${lo}..${hi} vs code ${MIN_WEEKS}..${MAX_WEEKS}`)
  ok('and permits nothing the reshaper cannot produce', lo >= MIN_WEEKS && hi <= MAX_WEEKS, `schema ${lo}..${hi} vs code ${MIN_WEEKS}..${MAX_WEEKS}`)
}

console.log('\n-- program_id lives HERE, and could not have lived in 094 --')
{
  // The pair property, asserted from both sides. 094 shipped alone and must
  // stay appliable alone; 095 is where the FK's target exists.
  ok('095 adds bookings.program_id', /alter\s+table\s+bookings\s+add\s+column\s+if\s+not\s+exists\s+program_id/i.test(sql))
  ok('and it references client_programs', /program_id\s+uuid\s+references\s+client_programs\s*\(\s*id\s*\)/i.test(sql))
  ok('094 still does NOT reference client_programs', !/client_programs/.test(sql094), '094 must remain appliable on its own')
  ok('094 still does NOT mention program_id', !/program_id/.test(sql094))

  // The table must be created BEFORE the column that points at it, or the
  // migration fails on its own — the exact defect that split 094 from 095.
  const createIdx = sql.search(/create\s+table\s+if\s+not\s+exists\s+client_programs\b/i)
  const alterIdx = sql.search(/alter\s+table\s+bookings\s+add\s+column\s+if\s+not\s+exists\s+program_id/i)
  ok('client_programs is created before bookings points at it', createIdx >= 0 && alterIdx > createIdx, `create@${createIdx} alter@${alterIdx}`)
}

console.log('\n-- a booking outlives its program; a program takes its children --')
{
  // Written out as the rule, not copied from the file: deleting a program must
  // never delete a booking. A real call happened, and the record of it is not
  // the program's to destroy.
  const bookingLink = /program_id\s+uuid\s+references\s+client_programs\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i
  ok('bookings.program_id is ON DELETE SET NULL', bookingLink.test(sql), 'a deleted program must not delete a real booking')
  ok('and specifically NOT cascade', !/program_id\s+uuid\s+references\s+client_programs\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i.test(sql))

  // Every child table hangs off the program and goes with it.
  for (const child of ['client_program_items', 'client_program_notes', 'client_program_session_requests']) {
    const block = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${child}\\b([\\s\\S]*?)\\n\\);`, 'i').exec(sql)
    ok(`${child} exists`, block !== null)
    ok(
      `${child} cascades from client_programs`,
      /program_id\s+uuid\s+not\s+null\s+references\s+client_programs\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i.test(block?.[1] ?? ''),
      'an orphaned child of a deleted program is unreachable data'
    )
  }

  // A deleted item must not delete the request it was attached to, and a
  // deleted booking must not delete the request that produced it.
  ok('session_requests.item_id is SET NULL', /item_id\s+uuid\s+references\s+client_program_items\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i.test(sql))
  ok('session_requests.booking_id is SET NULL', /booking_id\s+uuid\s+references\s+bookings\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i.test(sql))

  // A deleted LEAD must not destroy a running program — the client is a real
  // person whether or not the lead row survives.
  ok('client_programs.lead_id is SET NULL, not cascade', /lead_id\s+uuid\s+references\s+funnel_leads\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i.test(sql))
  // But a deleted COACH does take their programs, because nobody can deliver them.
  ok('client_programs.user_id cascades from users', /user_id\s+uuid\s+not\s+null\s+references\s+users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i.test(sql))
}

console.log('\n-- one spelling of cancelled, matching bookings.status --')
{
  // Production bookings.status is 'canceled', one L. The two are read side by
  // side, and a spelling split would be invisible until a query returned
  // nothing rather than erroring.
  //
  // Asserted against the VALUE, not the file. Prose in this repo is British
  // ("when a booking was cancelled") while the stored value is American, and
  // 094 is written that way throughout — a whole-file check would fail 094 and
  // teach the next person to weaken the guard rather than aim it. Same trap as
  // the avatar leak assertion: the container is not the thing.
  ok('no VALUE in the DDL uses the two-L spelling', !/cancelled/i.test(sql), 'bookings.status is `canceled`')

  // Stronger than "contains 'canceled'": the vocabulary is pinned exactly, so
  // adding a state is a deliberate edit here rather than a silent widening.
  const statusList = /status\s+text\s+not\s+null\s+default\s+'draft'\s*\n?\s*check\s*\(\s*status\s+in\s*\(([^)]*)\)\s*\)/i.exec(sql)
  ok('the program status CHECK is parseable', statusList !== null)
  const states = (statusList?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  eq('exactly the five program states', states, ['draft', 'active', 'completed', 'paused', 'canceled'])
}

console.log('\n-- the constraints that carry product rules --')
{
  // At most one OPEN request per program. Partial unique index rather than a
  // handler check, because two concurrent taps both pass a read-then-write.
  ok(
    'one open session request per program, enforced by a partial unique index',
    /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_session_request_open\s+on\s+client_program_session_requests\s*\(\s*program_id\s*\)\s+where\s+status\s*=\s*'requested'/i.test(sql),
    'a handler-only check loses the race'
  )
  // One program per lead per coach, but any number of hand-added clients.
  ok(
    'one program per (coach, lead), only where a lead exists',
    /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_client_programs_lead\s+on\s+client_programs\s*\(\s*user_id,\s*lead_id\s*\)\s+where\s+lead_id\s+is\s+not\s+null/i.test(sql)
  )

  // sessions_allowed is independent of total_weeks and 0 is legal — a program
  // with no calls is a real product, not a misconfiguration.
  const s = /sessions_allowed\s+integer\s+not\s+null\s+default\s+(\d+)\s+check\s*\(\s*sessions_allowed\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i.exec(sql)
  ok('sessions_allowed has a bound', s !== null)
  eq('and 0 is inside it', s ? Number(s[2]) : NaN, 0)
  ok('and it is NOT tied to total_weeks', s !== null && Number(s[3]) > MAX_WEEKS, 'calls are independent of weeks')

  // Position and identity are separate columns, which is the whole reason
  // resequencing can renumber one without corrupting the other.
  ok('sequence_position is required and >= 1', /sequence_position\s+integer\s+not\s+null\s+check\s*\(\s*sequence_position\s*>=\s*1\s*\)/i.test(sql))
  ok('source_week is OPTIONAL — a coach-added task came from no snapshot week', /source_week\s+integer\s+check\s*\(\s*source_week\s*>=\s*1\s*\)/i.test(sql))
  ok('they are two distinct columns', /\bsequence_position\b/.test(sql) && /\bsource_week\b/.test(sql))

  // due_date_source is what stops a recompute from overwriting a hand-typed date.
  ok("due_date_source defaults to 'derived'", /due_date_source\s+text\s+not\s+null\s+default\s+'derived'/i.test(sql))
  ok("and permits 'manual'", /due_date_source\s+in\s*\([^)]*'manual'[^)]*\)/i.test(sql))

  // Who ticked an item is a different fact from whether it is ticked.
  ok('completed_by distinguishes coach from client', /completed_by\s+text\s+check\s*\(\s*completed_by\s+in\s*\(\s*'coach',\s*'client'\s*\)\s*\)/i.test(sql))

  // Notes carry an audience, and it is the only thing separating a private
  // observation from something the client reads.
  ok('notes carry a visibility', /visibility\s+text\s+not\s+null\s+check\s*\(\s*visibility\s+in\s*\(\s*'coach_only',\s*'coach_and_client'\s*\)\s*\)/i.test(sql))
}

console.log('\n-- absence is UNKNOWN, so nothing here is NOT NULL that cannot be known --')
{
  // client_timezone NULL means we do not know the client's zone, and the reader
  // substitutes UTC. If it were NOT NULL with a default of 'UTC', "we never
  // asked" and "they are in London" would be the same row.
  ok('client_timezone is nullable', /client_timezone\s+text\s*,/i.test(sql) && !/client_timezone\s+text\s+not\s+null/i.test(sql))
  // Same for the timestamps that mark events which may not have happened yet.
  for (const col of ['activated_at', 'completed_at', 'portal_last_opened_at']) {
    ok(`${col} is nullable`, new RegExp(`${col}\\s+timestamptz\\s*[,)\\n]`, 'i').test(sql) && !new RegExp(`${col}\\s+timestamptz\\s+not\\s+null`, 'i').test(sql))
  }
}

console.log('\n-- house rules --')
{
  // text + CHECK, never a Postgres enum: widening a CHECK is one migration.
  ok('no Postgres enum types are created', !/create\s+type\s+\S+\s+as\s+enum/i.test(sql))
  // No RLS: this schema serves these tables with the service-role client, so an
  // auth.uid() policy would be silently bypassed rather than enforced.
  ok('no RLS is enabled on these tables', !/enable\s+row\s+level\s+security/i.test(sql))
  // Re-runnable, like every other migration here.
  eq('four tables, all `if not exists`', (sql.match(/create\s+table\s+if\s+not\s+exists\s+client_program/gi) || []).length, 4)
  const creates = (sql.match(/create\s+table\b/gi) || []).length
  eq('and no table is created without that guard', (sql.match(/create\s+table\s+if\s+not\s+exists/gi) || []).length, creates)
  const idx = (sql.match(/create\s+(unique\s+)?index\b/gi) || []).length
  eq('every index is guarded too', (sql.match(/create\s+(unique\s+)?index\s+if\s+not\s+exists/gi) || []).length, idx)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
