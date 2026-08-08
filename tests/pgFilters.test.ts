// User input reaching a PostgREST filter is SYNTAX, not a value.
//
// The instance was api/client/program/resend.ts — `%` on a public recovery form
// matching every row. This file is the CLASS: the escaper itself, the fact the
// whole thing rests on (a public validator that accepts `%`), the two reads that
// were unescaped, and a sweep so a third one cannot appear quietly.
//
// THE SHARP CASE IS THE WRITE. api/leads/[leadId]/outcome.ts reads bookings by
// ilike on a stored address and hands the result to pickBooking, which hands it
// to an UPDATE. Unescaped, recording an outcome on a planted lead stamps
// attendance on a real customer's upcoming call.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect, ilikeMatches, countHeaders } from './support/postgrest'
import { escapeLike, escapeForOr } from '../lib/pgFilters'
import { isEmailAddress } from '../lib/emailAddress'
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

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

const COACH = '5c8ba4ad-0c04-4816-9fcf-b0b988a74ae6'
const F1 = 'funnel-1'

// THE PLANTED ADDRESS. Not invented for the test: it passes
// api/funnel/lead.ts's own validator (asserted below) and is therefore
// something a stranger can put in a coach's database through a public form.
// As a LIKE pattern it matches every address in the table.
const PLANTED = '%@%.%'
const REAL = 'dana@example.invalid'
// A REAL address that is also a LIKE pattern. `_` is legal atext and a wildcard,
// so this passes every validator that does not reject real people — and matches
// the victim below. This pair is why the escape outlives the validator.
const PATTERNED = 'foo_bar@example.com'
const PATTERNED_VICTIM = 'fooXbar@example.com'
const PLANTED_LEAD = 'lead-planted'
const REAL_LEAD = 'lead-real'
const REAL_BOOKING = 'booking-real'

let tables: Record<string, any[]> = {}
let seq = 0

function reset() {
  seq = 0
  tables = {
    users: [{ id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} }],
    funnels: [{ id: F1, user_id: COACH, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }],
    funnel_leads: [
      // Opted in through the public form. No booking, no history — a junk row.
      { id: PLANTED_LEAD, funnel_id: F1, email: PLANTED, name: null, first_name: null, status: 'lead', close_amount: null, notes: null, application_status: null, application_submitted_at: null, opted_in_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', phone: null },
      { id: REAL_LEAD, funnel_id: F1, email: REAL, name: 'Dana Mercer', first_name: 'Dana', status: 'booked', close_amount: null, notes: null, application_status: null, application_submitted_at: null, opted_in_at: '2026-01-02T00:00:00.000Z', created_at: '2026-01-02T00:00:00.000Z', phone: null },
    ],
    // A REAL customer's call, unmarked, in the future. This is the row the
    // unescaped read reaches and the write stamps.
    bookings: [
      {
        id: REAL_BOOKING,
        funnel_id: F1,
        coach_user_id: COACH,
        email: REAL,
        name: 'Dana Mercer',
        start_time: '2099-01-01T15:00:00.000Z',
        end_time: '2099-01-01T15:30:00.000Z',
        attended: null,
        attendance_marked_at: null,
        status: 'active',
        zoom_join_url: null,
        meeting_url: null,
        custom_answers: null,
        reschedule_count: 0,
        canceled_at: null,
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ],
    funnel_lead_notes: [],
    funnel_events: [],
    funnel_email_sends: [],
    ai_coach_messages: [],
    client_programs: [],
  }
}

const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
const inParam = (url: string, key: string) => {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((x) => x.replace(/^"|"$/g, '')) : null
}
function wantsObject(init: any): boolean {
  const h = init?.headers
  const accept = h && typeof h.get === 'function' ? h.get('Accept') : h?.Accept ?? h?.accept
  return /vnd\.pgrst\.object/.test(String(accept || ''))
}
function matches(url: string, row: Record<string, any>): boolean {
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=eq\.([^&]+)/g)) {
    if (key === 'select' || key === 'order' || key === 'limit') continue
    if (String(row[key]) !== val) return false
  }
  // MODELLED AS A PATTERN. A stub comparing literally would report this whole
  // file green with every escape removed.
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=ilike\.([^&]+)/g)) {
    if (!ilikeMatches(val, row[key])) return false
  }
  for (const [, key] of url.matchAll(/[?&]([a-z_]+)=in\./g)) {
    const list = inParam(url, key)
    if (list && !list.includes(String(row[key]))) return false
  }
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=is\.([^&]+)/g)) {
    if (val === 'null' && row[key] !== null && row[key] !== undefined) return false
  }
  return true
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), {
      status,
      headers: { 'Content-Type': 'application/json', ...extra },
    })

  if (url.includes('api.resend.com')) return json({ id: 'msg' })

  if (method === 'HEAD') {
    const t = tableOf(url)
    const hit = (tables[t] || []).filter((r) => matches(url, r))
    return new Response(null, { status: 200, headers: countHeaders(url, init, hit.length) })
  }

  const table = tableOf(url)
  if (!table) return json([])
  tables[table] = tables[table] || []

  if (method === 'POST') {
    const rows = (Array.isArray(body) ? body : [body]).map((r: any) => ({ id: r.id ?? `${table}-${++seq}`, ...r }))
    tables[table].push(...rows)
    return json(wantsObject(init) ? rows[0] ?? null : rows)
  }
  if (method === 'PATCH') {
    const hit = tables[table].filter((r) => matches(url, r))
    for (const r of hit) Object.assign(r, body)
    return json(wantsObject(init) ? hit[0] ?? null : hit)
  }
  if (method === 'DELETE') {
    tables[table] = tables[table].filter((r) => !matches(url, r))
    return json([])
  }
  const rows = tables[table].filter((r) => matches(url, r))
  // The count travels in Content-Range, the way PostgREST sends it.
  return json(wantsObject(init) ? rows[0] ?? null : rows, 200, countHeaders(url, init, rows.length))
}) as typeof fetch

async function coach(handler: Handler, opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const token = await createSessionToken(COACH)
  let status = 0
  let out: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { out = v; return res },
    end() { return res },
  }
  await handler(
    { method: opts.method || 'GET', headers: { authorization: `Bearer ${token}` }, query: opts.query || {}, body: opts.body ?? null } as any,
    res
  )
  return { status, body: out }
}

;(async () => {
  const { readFileSync, readdirSync, statSync } = await import('fs')
  const { join } = await import('path')

  console.log('\n-- the escaper, both directions --')
  {
    // Both ways, so "escapes everything" fails as loudly as "escapes nothing".
    eq('a percent is neutralised', escapeLike('a%b'), 'a\\%b')
    eq('an underscore too', escapeLike('a_b'), 'a\\_b')
    eq('and a backslash FIRST, or it re-escapes what the others add', escapeLike('a\\%b'), 'a\\\\\\%b')
    eq('an ordinary address is untouched', escapeLike(REAL), REAL)
    eq('and so is a dot, which LIKE does not special-case', escapeLike('a.b@c.d'), 'a.b@c.d')

    // Against the pattern matcher, which is what actually decides.
    ok('unescaped, the planted address matches a real one', ilikeMatches(PLANTED, REAL))
    ok('escaped, it matches only itself', !ilikeMatches(escapeLike(PLANTED), REAL))
    ok('and it still matches itself', ilikeMatches(escapeLike(PLANTED), PLANTED))
    // Case-insensitivity is the reason ilike is used at all — escaping must not
    // cost it, or the fix breaks the behaviour it was protecting.
    ok('case-insensitivity survives escaping', ilikeMatches(escapeLike('Dana@Example.invalid'), REAL))

    eq('escapeForOr strips filter syntax', escapeForOr('a,b(c)d\\e'), 'a b c d e')
    // Separate concerns, stated so nobody assumes one covers the other.
    eq('and does NOT touch LIKE wildcards', escapeForOr('a%b_c'), 'a%b_c')
  }

  console.log('\n-- THE FACT THIS ALL RESTS ON: a REAL address that is still a PATTERN --')
  {
    // THIS BLOCK USED TO PIN A DIFFERENT PREMISE — that the public opt-in
    // validator accepted `%`, which is why `%@%.%` could be planted through a
    // form. lib/emailAddress.ts closed that door, so the old assertion would now
    // fail on the fix rather than on a regression.
    //
    // The premise it was really protecting is the one below, and it survives the
    // validator by construction: `_` is a LIKE wildcard AND legal in a local
    // part, so a genuinely real address is simultaneously a pattern. No
    // validator can reject `foo_bar@example.com` without rejecting a real
    // person, which is exactly why escapeLike cannot be deleted on the grounds
    // that "the input is validated now."
    ok('a real address is accepted by the validator', isEmailAddress(PATTERNED))
    ok('and it is a PATTERN that matches a different address', ilikeMatches(PATTERNED, PATTERNED_VICTIM))
    ok('escaped, it matches only itself', !ilikeMatches(escapeLike(PATTERNED), PATTERNED_VICTIM))
    ok('and still matches itself', ilikeMatches(escapeLike(PATTERNED), PATTERNED))

    // The wildcard address is no longer creatable through a public form — that
    // is the validator's whole contribution — but rows written before it, and
    // any future path that does not validate, still reach the readers. The
    // escape is what makes those safe, so the fixtures below keep using it.
    ok('the wildcard address is now REFUSED at the door', !isEmailAddress(PLANTED))
    ok('but it is still a pattern if it is already in the table', ilikeMatches(PLANTED, REAL))
  }

  console.log('\n-- THE WRITE: an outcome on a planted lead must not touch a real booking --')
  {
    reset()
    const { default: outcome } = await import('../api/leads/[leadId]/outcome')

    const before = tables.bookings.find((b: any) => b.id === REAL_BOOKING)
    eq('the real call starts unmarked', [before.attended, before.attendance_marked_at], [null, null])

    const res = await coach(outcome, { method: 'POST', query: { leadId: PLANTED_LEAD }, body: { outcome: 'no_show' } })

    // The planted lead has no booking of its own, so there is nothing to mark.
    eq('the coach is told there is no call to mark', [res.status, res.body?.error], [400, 'no_booking'])

    // RE-READ THE ROW. The status alone would pass even if the update had
    // already landed — the state is the thing under test.
    const after = tables.bookings.find((b: any) => b.id === REAL_BOOKING)
    eq("the real customer's call is untouched", [after.attended, after.attendance_marked_at], [null, null])
  }

  console.log('\n-- and a real lead still marks its OWN booking --')
  {
    reset()
    const { default: outcome } = await import('../api/leads/[leadId]/outcome')
    // The positive control. Without it, a handler that matched nothing at all
    // would pass the block above and this whole file would be asserting that
    // the feature is broken.
    const res = await coach(outcome, { method: 'POST', query: { leadId: REAL_LEAD }, body: { outcome: 'no_show' } })
    eq('accepted', res.status, 200)
    const after = tables.bookings.find((b: any) => b.id === REAL_BOOKING)
    eq('and the call is marked', after.attended, 'no_show')
    ok('with a timestamp', typeof after.attendance_marked_at === 'string')
  }

  console.log('\n-- THE READ: over-fetched, then discarded by a SECOND layer --')
  {
    reset()
    const { default: contact } = await import('../api/contacts/[leadId]')
    const planted = await coach(contact, { query: { leadId: PLANTED_LEAD } })
    eq('the page loads', planted.status, 200)
    const wire = JSON.stringify(planted.body)

    // MEASURED, NOT ASSUMED, and the measurement changed the claim. Removing the
    // escaping here does NOT leak: the ilike over-fetches the real customer's
    // booking, and buildBookingIndex then re-keys on the EXACT
    // (funnel_id, lower(email)) pair, which `%@%.%` does not equal. So these two
    // assertions pass either way and cannot be the guard.
    //
    // Nor do they guard buildBookingIndex: measured, mutating it to return every
    // funnel booking ALSO leaves them green, because with the escaping in place
    // the query returns nothing for this lead and there is no over-fetch left to
    // mis-key. Two layers, and each one makes the other's test inert.
    //
    // So what is below is a POSITIVE CONTROL and nothing more — proof the
    // endpoint returns a booking at all, without which "no leak" would also be
    // satisfied by an endpoint that returns nothing. The escaping itself is
    // asserted at the artifact level in the sweep, which is the same resolution
    // the note-visibility double filter needed.
    ok("no other customer's address on the wire", !wire.includes(REAL), wire.slice(0, 400))
    ok('nor their booking id', !wire.includes(REAL_BOOKING))

    const real = await coach(contact, { query: { leadId: REAL_LEAD } })
    eq('the real lead loads', real.status, 200)
    ok('and DOES carry their own booking', JSON.stringify(real.body).includes(REAL_BOOKING), JSON.stringify(real.body).slice(0, 400))
  }

  console.log('\n-- the discovery COUNT has no second layer, so the over-fetch reaches the UI --')
  {
    reset()
    // client_programs.client_email is caller-supplied on create. The count is a
    // head-only `count: exact` with nothing downstream to re-filter it, so an
    // unescaped pattern inflates a number a coach reads as fact.
    tables.client_programs = [
      { id: 'prog-1', user_id: COACH, lead_id: null, client_name: 'Planted', client_email: PLANTED, client_timezone: null, program_name: 'P', total_weeks: 1, sessions_allowed: 1, start_date: '2026-01-05', status: 'active', portal_token_version: 1, portal_last_opened_at: null, activated_at: null, completed_at: null },
    ]
    tables.client_program_items = []
    tables.client_program_notes = []
    tables.client_program_session_requests = []
    const { default: programRoute } = await import('../api/client-programs/[id]')
    const res = await coach(programRoute, { query: { id: 'prog-1' } })
    eq('the programme loads', res.status, 200)
    // The real customer's discovery call belongs to somebody else entirely.
    eq('the count is 0, not 1', res.body?.discovery_call_count, 0)
  }

  console.log('\n-- THE CLASS: every LIKE filter in the codebase, by verdict --')
  {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    type Site = { file: string; call: string; verdict: string }
    const sites: Site[] = []
    for (const file of [...walk('api'), ...walk('lib')]) {
      const src = stripComments(readFileSync(file, 'utf8'))
      // The value argument, up to the closing paren of the call.
      for (const m of src.matchAll(/\.i?like\(\s*(['"`])[a-z_]+\1\s*,\s*([^\n]*?)\)(?=[,;\s.)])/g)) {
        const arg = m[2].trim()
        const verdict = arg.startsWith('escapeLike(')
          ? 'escaped'
          : /^(['"`])[^`]*\1$/.test(arg) && !arg.includes('${')
            ? 'literal'
            : arg.includes('${')
              ? 'interpolated'
              : 'bare'
        sites.push({ file, call: arg, verdict })
      }
    }

    // THE DISTRIBUTION, not the failure count. A predicate that classifies
    // everything as 'literal' and one that classifies nothing both report zero
    // failures; only the spread tells them apart.
    const byVerdict: Record<string, number> = {}
    for (const s of sites) byVerdict[s.verdict] = (byVerdict[s.verdict] || 0) + 1
    console.log('     ', JSON.stringify(byVerdict), `across ${sites.length} sites`)

    ok('the sweep finds LIKE filters at all', sites.length >= 8, `found ${sites.length} — the predicate stopped matching`)
    ok('it finds escaped ones', (byVerdict.escaped || 0) >= 4, JSON.stringify(byVerdict))
    ok('and literal ones', (byVerdict.literal || 0) >= 2, JSON.stringify(byVerdict))

    // NO BARE VALUES. This is the property: a stored string handed to a pattern
    // matcher without being escaped first.
    const bare = sites.filter((s) => s.verdict === 'bare')
    ok('no LIKE filter takes a bare value', bare.length === 0, bare.map((s) => `${s.file}: ${s.call}`).join('\n      '))

    // Interpolated ones are ALLOWLISTED BY FILE WITH A REASON, so a new one is a
    // decision somebody has to make rather than a default they inherit.
    const INTERPOLATED_OK: Record<string, string> = {
      // kindPrefix is a private union ('nurture' | 'book_a_call' | 'post_call'),
      // never caller input, and the trailing % is the intended prefix match.
      'lib/funnelNurture.ts': 'developer-owned kind prefix, % is deliberate',
      // Admin-only search box. The surrounding %..% IS the feature; `safe` has
      // already been through escapeForOr for the or= syntax. A % typed by an
      // admin widens their own results and reaches nothing they cannot list
      // anyway. See the report — this one is deliberately NOT escaped.
      'api/admin/support/tickets.ts': 'admin search, substring match is the intent',
    }
    for (const s of sites.filter((x) => x.verdict === 'interpolated')) {
      ok(`${s.file} interpolates deliberately (${INTERPOLATED_OK[s.file] || '??'})`, !!INTERPOLATED_OK[s.file], `unaccounted interpolation: ${s.call}`)
    }

    // BY NAME, so the four reads that were fixed cannot quietly revert. Named
    // rather than counted: a count stays right while the wrong file is escaped.
    for (const file of [
      'api/client/program/resend.ts',
      'api/client-programs/index.ts',
      'api/client-programs/[id].ts',
      'api/contacts/[leadId].ts',
      'api/leads/[leadId]/outcome.ts',
    ]) {
      const mine = sites.filter((s) => s.file === file)
      ok(`${file} has a LIKE filter`, mine.length > 0)
      ok(`${file} escapes every one`, mine.every((s) => s.verdict === 'escaped'), mine.map((s) => s.call).join(' | '))
    }

    // ONE OWNER. Three copies of this function existed for one commit; a fourth
    // is how they start disagreeing about whether backslash comes first.
    const copies = [...walk('api'), ...walk('lib')].filter(
      (f) => f !== 'lib/pgFilters.ts' && /function escape(Like|ForOr)\s*\(/.test(readFileSync(f, 'utf8'))
    )
    eq('escapeLike/escapeForOr are defined in exactly one place', copies, [])
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
