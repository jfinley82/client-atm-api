// bookings.lead_id — RECORDED, not reconstructed.
//
// The property: a booking's lead is recorded at write time, and where it cannot
// be recorded the absence is EXPLICIT rather than a join returning nothing.
//
// The half that needs the most guarding is the half that is a definition rather
// than a mechanism: nothing may resolve this column from a read-time
// (coach, email) match. A guessed uuid and a recorded one are the same bytes, so
// the only durable defence is bounding who writes it — §6 item 6.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

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

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

const MIGRATION = 'supabase/migrations/096_bookings_lead_id.sql'

;(async () => {
  console.log('\n-- the migration says what the column is, and the DDL matches --')
  {
    const raw = readFileSync(MIGRATION, 'utf8')
    // DDL only. The prose above it says `on delete set null` in English too, and
    // a check against the whole file would pass on the comment while the SQL
    // said something else — the container-shaped guard, one file over.
    const ddl = raw.replace(/--[^\n]*/g, '')

    ok('the column is added', /alter table bookings[\s\S]*?add column if not exists lead_id uuid/i.test(ddl))
    ok('it references funnel_leads', /references\s+funnel_leads\s*\(\s*id\s*\)/i.test(ddl))

    // ON DELETE SET NULL, NOT CASCADE. The call happened; deleting the lead must
    // not delete the record of it. Asserted BOTH ways, so "matches everything"
    // fails as loudly as "matches nothing".
    ok('on delete set null', /on delete set null/i.test(ddl))
    ok('and NOT cascade', !/on delete cascade/i.test(ddl), 'a cascade would rewrite history when someone tidies their CRM')

    // Nullable is the whole design — 8 of 11 production rows are permanently null.
    ok('the column is nullable', !/lead_id uuid[^,;]*not null/i.test(ddl))

    ok('the index is partial on non-null', /create index[\s\S]*?idx_bookings_lead_id[\s\S]*?where lead_id is not null/i.test(ddl))

    // §6 item 2 — the backfill refuses the ambiguous case rather than picking.
    ok('the backfill excludes ambiguous matches', /not exists\s*\([\s\S]*?l2\.id\s*<>\s*l\.id/i.test(ddl))
    ok('and matches case-insensitively on both sides', (ddl.match(/lower\(btrim\(/g) || []).length >= 4)

    // §2 — there is NO coach-page rule, and its absence is the decision.
    ok('the backfill never resolves via coach_user_id', !/coach_user_id/i.test(ddl), 'a coach-page rule would write the contacts heuristic into the column')

    // The definition is stated in the file, because the file is what a future
    // reader has. Prose, deliberately — this is the one thing no DDL can express.
    const prose = raw
    ok('the file states that a value is a record, never a derivation', /record, never a derivation/i.test(prose))
    ok('and that funnel_id is not duplication', /funnel_id STAYS/i.test(prose))
    ok('and records the begin/rollback numbers', /11 bookings, 3 backfilled/i.test(prose))
  }

  console.log('\n-- §6 item 6: the writers are BOUNDED, by name --')
  {
    // THE DEFINITION COLLAPSES THE MOMENT A THIRD WRITER APPEARS. A read-time
    // heuristic writing this column is indistinguishable afterwards from a
    // recorded fact, so the guard is the SET of writers rather than any one of
    // them. Same shape as the public-writer sweep in publicWriteRateLimit.
    const writers: string[] = []
    for (const file of [...walk('api'), ...walk('lib')]) {
      const src = stripComments(readFileSync(file, 'utf8'))
      // THE PREDICATE IS THE THING THAT CAN BE WRONG HERE, and the first version
      // was: a loose window let it skip from a SELECT on `bookings` to an
      // unrelated `.update()` further down, then run past that object into a
      // `funnel_events` insert that legitimately carries a lead_id — reporting
      // api/leads/[leadId]/outcome.ts as a writer of a column it never touches.
      //
      // So: insert/update must follow `.from('bookings')` IMMEDIATELY, lead_id
      // must appear as a KEY (with its colon), and the window may not cross
      // another `.from(` — which is what stops it reading the next statement's
      // object as if it were this one's.
      if (/\.from\(['"]bookings['"]\)\s*\.(insert|update|upsert)\(\s*\{(?:(?!\.from\()[\s\S]){0,1200}?\blead_id\s*:/.test(src)) writers.push(file)
    }
    writers.sort()

    const EXPECTED = ['api/calendar/book.ts', 'api/client-programs/[id]/requests/[requestId].ts']
    eq('exactly two sites write bookings.lead_id', writers, EXPECTED)

    // Named explicitly, because a COUNT stays right while the wrong file is the
    // one writing. A count of two is satisfied by contacts.ts plus one.
    for (const f of EXPECTED) ok(`${f} is one of them`, writers.includes(f))

    // The one that must never be.
    ok('lib/contacts.ts does not write it', !writers.includes('lib/contacts.ts'), 'the read-time heuristic must never assert this foreign key')
    ok('nor does api/contacts/index.ts', !writers.includes('api/contacts/index.ts'))
    ok('nor api/calendar/index.ts', !writers.includes('api/calendar/index.ts'))
  }

  console.log('\n-- §6 item 5: both writers source it from something already resolved --')
  {
    const book = stripComments(readFileSync('api/calendar/book.ts', 'utf8'))
    const confirm = stripComments(readFileSync('api/client-programs/[id]/requests/[requestId].ts', 'utf8'))

    // book.ts records the id it ALREADY resolved for the funnel event and the
    // confirmation email — not a second lookup that could answer differently.
    ok('book.ts writes the resolved leadId', /\.from\('bookings'\)\s*\.insert\(\s*\{(?:(?!\.from\()[\s\S])*?lead_id: leadId/.test(book))
    // ANCHORED ON THE BOOKING INSERT, not on the first `lead_id: leadId` in the
    // file — the funnel_events insert uses the same key name and appears
    // earlier, so a bare indexOf compared the resolve against the wrong site and
    // reported the order backwards.
    ok(
      'and resolves it BEFORE that insert',
      book.indexOf('const leadId = funnelRow ? await resolveFunnelLead') <
        book.search(/\.from\('bookings'\)\s*\.insert\(/)
    )

    // The confirm path takes it off the programme row, which already carries it.
    ok('the session confirm writes program.lead_id', /lead_id: program\.lead_id/.test(confirm))
  }

  console.log('\n-- §6 item 1: the case fix, which production data cannot exercise --')
  {
    const book = stripComments(readFileSync('api/calendar/book.ts', 'utf8'))

    // THE FIXTURE PRODUCTION CANNOT PROVIDE. Zero mixed-case addresses exist, so
    // `.eq('email', …)` and `.ilike('email', …)` agree on every row that has ever
    // been written — a guard shaped like a container, passing until real data
    // shares it. Asserted at the source, because there is no row that can tell
    // the two apart.
    ok('the lead lookup is case-insensitive', /\.ilike\('email',/.test(book), "still .eq('email', …) — a lead who typed Dana@ resolves to null here and to a real lead everywhere else")
    ok('and it is not the old case-sensitive form', !/\.eq\('email', email\)/.test(book))

    // And escaped, because it is a pattern and the address came off a public form.
    ok('the pattern is escaped', /\.ilike\('email', escapeLike\(/.test(book))

    // bookingKey is the other half of the pair. If it ever stops lowercasing,
    // the two disagree again from the opposite direction.
    const contacts = stripComments(readFileSync('lib/contacts.ts', 'utf8'))
    ok('bookingKey still lowercases, which is what book.ts now matches', /function bookingKey[\s\S]{0,300}?toLowerCase\(\)/.test(contacts))
  }

  console.log('\n-- §6 item 3: readers are UNTOUCHED, and the fallback is permanent --')
  {
    // The backfill covers 3 of 11. A reader that trusted lead_id alone would
    // lose the funnel-less rows the contacts heuristic finds — and for
    // coach-page bookings that fallback is permanent by definition (§2), not a
    // transitional state someone should delete later.
    const readers = ['api/calendar/index.ts', 'api/contacts/index.ts', 'api/contacts/[leadId].ts', 'api/leads/[leadId]/outcome.ts']
    for (const f of readers) {
      const src = stripComments(readFileSync(f, 'utf8'))
      ok(`${f} still joins on the email key`, /bookingKey|buildBookingIndex|ilike\('email'/.test(src))
      ok(`${f} does not read bookings.lead_id yet`, !/\bb\.lead_id\b|select\([^)]*bookings[^)]*lead_id/.test(src))
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
