// The first Client Programs endpoints that WRITE.
//
// The stub here does something the rest of the suite's stubs cannot: it REFUSES
// writes the database would refuse. Column projection made the reads honest;
// this makes the writes honest. A handler that violates uq_client_programs_lead
// or a CHECK is red here rather than in production, and `409 program_exists` has
// to come from the index rather than from a pre-check the handler could forget.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
import { checkWrite, applyDefaults, CLIENT_PROGRAM_CONSTRAINTS, PG_UNIQUE_VIOLATION } from './support/pgConstraints'
import { createSessionToken } from '../lib/auth'
import { planFromSnapshot, derivedDueDate, redriveDueDates, resolveSessionsAllowed, isValidStartDate } from '../lib/clientProgramPlan'
import { MAX_WEEKS } from '../lib/programReshape'

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
const OTHER_COACH = '0728feac-931a-42dd-9d87-053eea7fd88d'
const F1 = 'funnel-1'
const LEAD = 'lead-1'

const snapshot = (over: Record<string, any> = {}) => ({
  program_name: 'The Method',
  confirmed: true,
  total_weeks: 3,
  total_sessions: 4,
  weekly_breakdown: [
    { week: 1, phase_name: 'Foundations', session_focus: 'Get clear', client_milestone: 'Name the problem' },
    { week: 2, phase_name: 'Foundations', session_focus: 'Build', client_milestone: 'Draft it' },
    { week: 3, phase_name: 'Launch', session_focus: 'Ship', client_milestone: 'Publish' },
  ],
  ...over,
})

let tables: Record<string, any[]> = {}
let writeRejections: string[] = []
let seq = 0
// Forces the next insert into this table to fail, the way a transient database
// error would. Nothing the handler can see differs from a real failure.
let failInsertsInto: string | null = null

function reset() {
  seq = 0
  writeRejections = []
  failInsertsInto = null
  tables = {
    users: [{ id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} }],
    funnels: [{ id: F1, user_id: COACH, subdomain: 'f1', problem_solution_label: 'Coaches', landing_page: null }],
    funnel_leads: [{ id: LEAD, funnel_id: F1, email: 'Dana@Example.invalid', name: 'Dana Mercer', first_name: 'Dana' }],
    saved_outputs: [{ user_id: COACH, tool_type: 'program', content: snapshot() }],
    client_programs: [],
    client_program_items: [],
    client_program_notes: [],
    client_program_session_requests: [],
    bookings: [],
    funnel_email_sends: [],
  }
}

const eqParam = (url: string, key: string) => new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)?.[1] ?? null
const inParam = (url: string, key: string) => {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((x) => x.replace(/^"|"$/g, '')) : null
}
const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
// supabase-js sends this for .single()/.maybeSingle(); PostgREST then returns a
// bare object. Read defensively because the client may hand over a Headers
// instance rather than a plain object.
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
  for (const [, key] of url.matchAll(/[?&]([a-z_]+)=in\./g)) {
    const list = inParam(url, key)
    if (list && !list.includes(String(row[key]))) return false
  }
  return true
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  const table = tableOf(url)
  if (!table) return json([])
  tables[table] = tables[table] || []

  if (method === 'POST') {
    if (failInsertsInto === table) {
      return json({ code: 'XX000', message: 'simulated failure', details: null, hint: null }, 500)
    }
    const rows = Array.isArray(body) ? body : [body]
    const staged: any[] = []
    for (const raw of rows) {
      const constraints = CLIENT_PROGRAM_CONSTRAINTS[table]
      // Defaults first, then the checks — Postgres's own order.
      const row = applyDefaults({ id: raw.id ?? `${table}-${++seq}`, ...raw }, constraints)
      if (constraints) {
        // THE FAKE CAN SAY NO. Checked against the rows already staged in this
        // same call too, so a batch that violates a unique index inside itself
        // is refused the way Postgres refuses it.
        const violation = checkWrite(table, row, constraints, [...tables[table], ...staged], tables)
        if (violation) {
          writeRejections.push(`${table}:${violation.code}`)
          return json(violation, violation.code === PG_UNIQUE_VIOLATION ? 409 : 400)
        }
      }
      staged.push(row)
    }
    tables[table].push(...staged)
    // `.single()` sends Accept: application/vnd.pgrst.object+json and PostgREST
    // answers with ONE OBJECT, not a one-element array. A stub that always
    // returns the array leaves the handler destructuring `.id` off an array —
    // undefined — and the very next insert fails a NOT NULL it should satisfy.
    // Which is how this was found: the constraint fake refused the child rows.
    return json(wantsObject(init) ? staged[0] ?? null : staged)
  }

  if (method === 'PATCH') {
    const hit = tables[table].filter((r) => matches(url, r))
    for (const r of hit) Object.assign(r, body)
    return json(hit)
  }

  if (method === 'DELETE') {
    const before = tables[table].length
    tables[table] = tables[table].filter((r) => !matches(url, r))
    return json(new Array(before - tables[table].length).fill({}))
  }

  const rows = tables[table].filter((r) => matches(url, r))
  return json(wantsObject(init) ? rows[0] ?? null : rows)
}) as typeof fetch

async function call(handler: Handler, opts: { method?: string; query?: Record<string, string>; body?: unknown; user?: string } = {}) {
  const token = await createSessionToken(opts.user || COACH)
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
  const { default: programs } = await import('../api/client-programs/index')
  const { default: program } = await import('../api/client-programs/[id]')
  const { default: send } = await import('../api/client-programs/[id]/send')

  console.log('\n-- the fake enforces the REAL schema, checked against the migration --')
  {
    const { readFileSync } = await import('fs')
    const sql = readFileSync('supabase/migrations/095_client_programs.sql', 'utf8').replace(/--[^\n]*/g, '')

    // ARTIFACT AGAINST ARTIFACT. A CHECK widened in SQL and forgotten here would
    // leave the fake accepting a value the database still rejects — the guard
    // would be green and the constraint would be the thing under test.
    for (const [table, cons] of Object.entries(CLIENT_PROGRAM_CONSTRAINTS)) {
      // SCOPED TO THE TABLE'S OWN BLOCK. Four tables carry a `status` column
      // with four different vocabularies, so a file-wide search finds whichever
      // is declared first and reports it for all of them.
      const block = new RegExp(`create table if not exists ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql)?.[1] ?? ''
      ok(`${table} block located in 095`, block.length > 0)
      for (const [col, allowed] of Object.entries(cons.check || {})) {
        const m = new RegExp(`${col}\\s+text[^,]*?check\\s*\\(\\s*${col}\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(block)
        ok(`${table}.${col} CHECK is declared in 095`, m !== null, `no CHECK found for ${col}`)
        const inSql = (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
        eq(`${table}.${col} vocabulary matches the migration`, [...allowed].sort(), inSql.sort())
      }
    }
    // And the partial unique index the whole program_exists path depends on.
    ok('uq_client_programs_lead is partial on lead_id', /uq_client_programs_lead[\s\S]*?where\s+lead_id\s+is\s+not\s+null/i.test(sql))
  }

  console.log('\n-- the fake can actually say no, in every direction --')
  {
    // The harness is load-bearing now, and a harness that quietly stops
    // enforcing is worse than none — every write guard downstream would go green
    // together. Each rule is checked BOTH ways, so "rejects everything" fails
    // here just as loudly as "rejects nothing".
    const P = CLIENT_PROGRAM_CONSTRAINTS.client_programs
    const legal = { id: 'x', user_id: COACH, client_name: 'A', client_email: 'a@e.invalid', program_snapshot: {}, program_name: 'P', total_weeks: 4, start_date: '2026-01-05', status: 'draft', lead_id: null }
    const users = [{ id: COACH }]

    eq('a legal row is accepted', checkWrite('client_programs', legal, P, [], { users }), null)
    eq('a missing NOT NULL is 23502', checkWrite('client_programs', { ...legal, client_email: null }, P, [], { users })?.code, '23502')
    eq('a bad status is 23514', checkWrite('client_programs', { ...legal, status: 'archived' }, P, [], { users })?.code, '23514')
    eq('total_weeks past the CHECK is 23514', checkWrite('client_programs', { ...legal, total_weeks: 17 }, P, [], { users })?.code, '23514')
    eq('and inside it is fine', checkWrite('client_programs', { ...legal, total_weeks: 16 }, P, [], { users }), null)
    eq('a dangling user_id is 23503', checkWrite('client_programs', legal, P, [], { users: [] })?.code, '23503')

    // The partial unique index, both sides of its predicate.
    const withLead = { ...legal, lead_id: LEAD }
    eq('a second program for the same lead is 23505', checkWrite('client_programs', { ...withLead, id: 'y' }, P, [withLead], { users, funnel_leads: [{ id: LEAD }] })?.code, '23505')
    eq('but two LEAD-LESS programs do not collide', checkWrite('client_programs', { ...legal, id: 'y' }, P, [legal], { users }), null)

    const R = CLIENT_PROGRAM_CONSTRAINTS.client_program_session_requests
    const open1 = { id: 'r1', program_id: 'p1', status: 'requested' }
    eq('a second OPEN request is 23505', checkWrite('client_program_session_requests', { ...open1, id: 'r2' }, R, [open1], {})?.code, '23505')
    // The whole point of the index being partial.
    eq('a resolved one beside it is legal', checkWrite('client_program_session_requests', { id: 'r2', program_id: 'p1', status: 'declined' }, R, [open1], {}), null)
  }

  console.log('\n-- the snapshot mapping: two rows per position --')
  {
    const plan = planFromSnapshot(snapshot(), '2026-01-05')
    ok('the plan is accepted', plan.ok === true)
    if (plan.ok) {
      eq('three positions, six rows', [plan.total_weeks, plan.items.length], [3, 6])
      eq('every position has a week row', plan.items.filter((i) => i.kind === 'week').map((i) => i.sequence_position), [1, 2, 3])
      eq('and a milestone beside it', plan.items.filter((i) => i.kind === 'milestone').map((i) => i.sequence_position), [1, 2, 3])
      eq('headings sort first', plan.items.filter((i) => i.sequence_position === 1).map((i) => i.sort_order), [0, 1])
      // At creation the two numbers agree; they diverge only on resequence.
      ok('sequence_position === source_week everywhere', plan.items.every((i) => i.sequence_position === i.source_week))
      // A heading is not due — dating it would put two deadlines in every week.
      ok('week rows carry no due date', plan.items.filter((i) => i.kind === 'week').every((i) => i.due_date === null))
      eq('position 1 is due at the END of week 1', plan.items.find((i) => i.kind === 'milestone')?.due_date, '2026-01-11')
      eq('position 3 a fortnight later', plan.items.filter((i) => i.kind === 'milestone')[2].due_date, '2026-01-25')
    }

    // §6.1: a blank milestone produces NO row rather than an untitled one.
    const blank = planFromSnapshot(snapshot({ weekly_breakdown: [{ week: 1, phase_name: 'P', session_focus: 'F', client_milestone: '   ' }] }), '2026-01-05')
    ok('a blank milestone is dropped', blank.ok === true && blank.items.length === 1)
    ok('and the week row survives alone', blank.ok === true && blank.items[0].kind === 'week')
  }

  console.log('\n-- the plan refuses what it cannot build --')
  {
    eq('no snapshot at all', (planFromSnapshot(null, '2026-01-05') as any).reason, 'program_not_found')
    eq('an unconfirmed program', (planFromSnapshot(snapshot({ confirmed: false }), '2026-01-05') as any).reason, 'program_not_confirmed')
    eq('an empty breakdown', (planFromSnapshot(snapshot({ weekly_breakdown: [] }), '2026-01-05') as any).reason, 'program_empty')
    eq('a malformed entry', (planFromSnapshot(snapshot({ weekly_breakdown: [{ week: 1 }] }), '2026-01-05') as any).reason, 'program_empty')
    // A blank phase_name labels an unreadable segment of the phase rail.
    eq('a blank phase name', (planFromSnapshot(snapshot({ weekly_breakdown: [{ week: 1, phase_name: '  ', session_focus: 'F', client_milestone: 'M' }] }), '2026-01-05') as any).reason, 'program_empty')

    const long = planFromSnapshot(
      snapshot({ weekly_breakdown: Array.from({ length: MAX_WEEKS + 1 }, (_, n) => ({ week: n + 1, phase_name: 'P', session_focus: 'F', client_milestone: 'M' })) }),
      '2026-01-05'
    )
    eq('too long is refused', (long as any).reason, 'program_too_long')
    // NOT CLAMPED, and the number comes back — silently halving a coach's
    // program is a change they would never see.
    eq('and reports the length it refused', (long as any).total_weeks, MAX_WEEKS + 1)
    ok('exactly MAX_WEEKS is fine', planFromSnapshot(snapshot({ weekly_breakdown: Array.from({ length: MAX_WEEKS }, (_, n) => ({ week: n + 1, phase_name: 'P', session_focus: 'F', client_milestone: 'M' })) }), '2026-01-05').ok === true)
  }

  console.log('\n-- sessions_allowed: a suggestion, never a reason to fail --')
  {
    eq('the body wins', (resolveSessionsAllowed(6, snapshot()) as any).value, 6)
    eq('0 in the body is a CHOICE, not a missing value', (resolveSessionsAllowed(0, snapshot()) as any).value, 0)
    eq('the snapshot prefills', (resolveSessionsAllowed(undefined, snapshot()) as any).value, 4)
    eq('a decimal suggestion is rounded, not rejected', (resolveSessionsAllowed(undefined, snapshot({ total_sessions: 4.6 })) as any).value, 5)
    // Out of the CHECK's range is not a usable suggestion — accepting it would
    // turn a soft prefill into a 500 at insert time.
    eq('an out-of-range suggestion falls through', (resolveSessionsAllowed(undefined, snapshot({ total_sessions: 9999 })) as any).reason, 'sessions_allowed_required')
    eq('and junk does too', (resolveSessionsAllowed(undefined, snapshot({ total_sessions: 'lots' })) as any).reason, 'sessions_allowed_required')
    eq('only with neither is the caller asked', (resolveSessionsAllowed(null, {}) as any).reason, 'sessions_allowed_required')
  }

  console.log('\n-- start dates are real calendar days --')
  {
    ok('a real date passes', isValidStartDate('2026-02-28'))
    ok('the 30th of February does not', !isValidStartDate('2026-02-30'))
    ok('nor a wrong shape', !isValidStartDate('2026-2-8'))
    ok('nor a timestamp', !isValidStartDate('2026-02-08T00:00:00Z'))
  }

  console.log('\n-- CREATE: a draft, and nothing is sent --')
  {
    reset()
    const r = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('201', r.status, 201)
    eq('created as a draft', r.body?.program?.status, 'draft')
    eq('the client name came from the lead', r.body?.program?.client_name, 'Dana Mercer')
    eq('a draft has no current week', r.body?.program?.current_week, null)
    eq('six item rows were written', tables.client_program_items.length, 6)
    eq('sessions_allowed prefilled from the snapshot', r.body?.program?.sessions_allowed, 4)

    // §13.27 — a draft sends NOTHING.
    eq('no email record exists', tables.funnel_email_sends.length, 0)
    // NULL, which is the column's real default — not `undefined`, which is what
    // a fake that skipped defaults would have produced.
    eq('and activated_at is unset', tables.client_programs[0].activated_at, null)
  }

  console.log('\n-- CREATE: the UNIQUE index refuses the second one, not a pre-check --')
  {
    // The handler never queries for an existing program. If it did, two
    // concurrent creates would both pass the read and both write. The 409 has to
    // come from the index, which is what this fake can now produce.
    const second = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-02-01' } })
    eq('409 program_exists', [second.status, second.body?.error], [409, 'program_exists'])
    ok('and it came from the unique violation', writeRejections.includes(`client_programs:${PG_UNIQUE_VIOLATION}`), JSON.stringify(writeRejections))
    eq('still only one program', tables.client_programs.length, 1)
    // The rejected create must not leave items behind.
    eq('and no orphan items', tables.client_program_items.length, 6)
  }

  console.log('\n-- CREATE: if the items fail, the program row goes with them --')
  {
    // A PROGRAM WITH NO ITEMS IS WORSE THAN NO PROGRAM: uq_client_programs_lead
    // does not filter on status, so the empty shell holds the lead and the coach
    // cannot create the real one. There is no transaction across two PostgREST
    // calls, so the rollback is explicit and has to be tested.
    reset()
    failInsertsInto = 'client_program_items'
    const r = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    failInsertsInto = null

    eq('the create fails', r.status, 500)
    eq('and leaves NO program row behind', tables.client_programs.length, 0)
    eq('nor any items', tables.client_program_items.length, 0)

    // The lead is therefore still usable — the observable consequence of the
    // rollback, and the reason it matters.
    const retry = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('so the coach can try again', retry.status, 201)
  }

  console.log('\n-- CREATE: a hand-added client has no lead, and any number are legal --')
  {
    reset()
    const a = await call(programs, { method: 'POST', body: { client_name: 'A', client_email: 'a@example.invalid', start_date: '2026-01-05' } })
    const b = await call(programs, { method: 'POST', body: { client_name: 'B', client_email: 'b@example.invalid', start_date: '2026-01-05' } })
    // NULL is not equal to NULL in a unique index. Two lead-less programmes do
    // not collide, which is what makes hand-added clients possible at all.
    eq('both are created', [a.status, b.status], [201, 201])
    eq('two programmes exist', tables.client_programs.length, 2)
  }

  console.log('\n-- CREATE: ownership comes from the lead’s funnel, never the body --')
  {
    reset()
    tables.funnels[0].user_id = OTHER_COACH
    const r = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('403 forbidden', [r.status, r.body?.error], [403, 'forbidden'])
    eq('and nothing was written', tables.client_programs.length, 0)

    reset()
    tables.funnel_leads[0].funnel_id = null
    const noFunnel = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('a lead with no funnel is 400', [noFunnel.status, noFunnel.body?.error], [400, 'lead_has_no_funnel'])
  }

  console.log('\n-- CREATE: the refusals, each with its own code --')
  {
    for (const [label, content, expected, status] of [
      ['an unconfirmed program', snapshot({ confirmed: false }), 'program_not_confirmed', 400],
      ['an empty program', snapshot({ weekly_breakdown: [] }), 'program_empty', 400],
      ['no program at all', null, 'program_not_found', 400],
    ] as [string, any, string, number][]) {
      reset()
      tables.saved_outputs[0].content = content
      const r = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
      eq(label, [r.status, r.body?.error], [status, expected])
      eq(`${label} wrote nothing`, tables.client_programs.length, 0)
    }

    reset()
    tables.saved_outputs[0].content = snapshot({
      weekly_breakdown: Array.from({ length: MAX_WEEKS + 2 }, (_, n) => ({ week: n + 1, phase_name: 'P', session_focus: 'F', client_milestone: 'M' })),
    })
    const long = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('too long is 422 with the number', [long.status, long.body?.error, long.body?.total_weeks], [422, 'program_too_long', MAX_WEEKS + 2])

    reset()
    const badDate = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-02-30' } })
    eq('an impossible date is refused', [badDate.status, badDate.body?.error], [400, 'invalid_start_date'])
  }

  console.log('\n-- SEND is the only door to active, and it is one-way --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id

    // §13.30 — PATCH cannot activate, and must not have mailed anyone trying.
    const patchActive = await call(program, { method: 'PATCH', query: { id }, body: { status: 'active' } })
    eq('PATCH {status:active} on a draft is refused', [patchActive.status, patchActive.body?.error], [400, 'use_send_endpoint'])
    eq('the program is still a draft', tables.client_programs[0].status, 'draft')
    eq('and nothing was sent', tables.funnel_email_sends.length, 0)

    const sent = await call(send, { method: 'POST', query: { id } })
    eq('send flips it', [sent.status, sent.body?.program?.status], [200, 'active'])
    ok('and stamps activated_at', typeof tables.client_programs[0].activated_at === 'string')

    // Idempotent by REFUSAL. A second send must not restamp the moment the
    // client got access.
    const stamp = tables.client_programs[0].activated_at
    const again = await call(send, { method: 'POST', query: { id } })
    eq('a second send is 409', [again.status, again.body?.error], [409, 'not_draft'])
    eq('and activated_at did not move', tables.client_programs[0].activated_at, stamp)

    // No path back.
    const toDraft = await call(program, { method: 'PATCH', query: { id }, body: { status: 'draft' } })
    eq('PATCH back to draft is refused', [toDraft.status, toDraft.body?.error], [400, 'use_send_endpoint'])
    eq('still active', tables.client_programs[0].status, 'active')
  }

  console.log('\n-- two sends racing: exactly one wins --')
  {
    // Both read `draft` before either writes, so the pre-check passes twice and
    // only the `.eq('status','draft')` on the UPDATE can separate them. Without
    // it both activate and activated_at moves — the client's access moment
    // rewritten by a double-click.
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id

    const [a, b] = await Promise.all([call(send, { method: 'POST', query: { id } }), call(send, { method: 'POST', query: { id } })])
    const statuses = [a.status, b.status].sort()
    eq('one 200 and one 409', statuses, [200, 409])
    eq('the program is active', tables.client_programs[0].status, 'active')
    ok('and activated_at was stamped once', typeof tables.client_programs[0].activated_at === 'string')
  }

  console.log('\n-- the transitions PATCH does permit --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id
    await call(send, { method: 'POST', query: { id } })

    eq('active -> paused', (await call(program, { method: 'PATCH', query: { id }, body: { status: 'paused' } })).status, 200)
    eq('paused -> active', (await call(program, { method: 'PATCH', query: { id }, body: { status: 'active' } })).status, 200)
    eq('active -> completed', (await call(program, { method: 'PATCH', query: { id }, body: { status: 'completed' } })).status, 200)
    ok('completed_at is stamped', typeof tables.client_programs[0].completed_at === 'string')
    // completed -> active is not a transition; a finished programme that
    // restarts is a new one.
    const back = await call(program, { method: 'PATCH', query: { id }, body: { status: 'active' } })
    eq('completed -> active is refused', [back.status, back.body?.error], [400, 'invalid_transition'])
    eq('anything -> canceled', (await call(program, { method: 'PATCH', query: { id }, body: { status: 'canceled' } })).status, 200)
  }

  console.log('\n-- PATCH is an allowlist, and an unknown key names itself --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id
    const r = await call(program, { method: 'PATCH', query: { id }, body: { program_snapshot: { evil: true } } })
    eq('an unpatchable key is 400 with its name', [r.status, r.body?.error, r.body?.field], [400, 'invalid_field', 'program_snapshot'])
    eq('and the snapshot is untouched', tables.client_programs[0].program_snapshot.program_name, 'The Method')

    // The one that matters most: user_id is not editable, so a program cannot be
    // handed to another account by PATCH.
    const steal = await call(program, { method: 'PATCH', query: { id }, body: { user_id: OTHER_COACH } })
    eq('user_id is not patchable', [steal.status, steal.body?.field], [400, 'user_id'])
    eq('the owner is unchanged', tables.client_programs[0].user_id, COACH)
  }

  console.log('\n-- revoking the portal link bumps the version --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id
    const before = tables.client_programs[0].portal_token_version ?? 1
    await call(program, { method: 'PATCH', query: { id }, body: { revoke_portal_link: true } })
    eq('the version moved', tables.client_programs[0].portal_token_version, before + 1)
  }

  console.log('\n-- moving start_date re-derives ONLY what the coach did not set --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id

    const milestones = tables.client_program_items.filter((i: any) => i.kind === 'milestone')
    // One of them becomes the coach's own decision.
    milestones[1].due_date = '2026-03-03'
    milestones[1].due_date_source = 'manual'

    await call(program, { method: 'PATCH', query: { id }, body: { start_date: '2026-02-02' } })

    const after = tables.client_program_items.filter((i: any) => i.kind === 'milestone')
    eq('a derived date moved with the start date', after[0].due_date, derivedDueDate('2026-02-02', 1))
    eq('the MANUAL date survived untouched', after[1].due_date, '2026-03-03')
    eq('and the third moved too', after[2].due_date, derivedDueDate('2026-02-02', 3))
    // Re-derivation MOVES dates; it does not create them.
    ok('week rows are still undated', tables.client_program_items.filter((i: any) => i.kind === 'week').every((i: any) => i.due_date === null))
  }

  console.log('\n-- redriveDueDates, directly --')
  {
    const rows = [
      { sequence_position: 1, due_date: '2026-01-11', due_date_source: 'derived' as const },
      { sequence_position: 2, due_date: '2026-03-03', due_date_source: 'manual' as const },
      { sequence_position: 3, due_date: null, due_date_source: 'derived' as const },
    ]
    const out = redriveDueDates(rows, '2026-02-02')
    eq('derived moves', out[0].due_date, derivedDueDate('2026-02-02', 1))
    eq('manual does not', out[1].due_date, '2026-03-03')
    eq('and an undated row stays undated', out[2].due_date, null)
  }

  console.log('\n-- DELETE frees the lead, but only while draft --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id

    const del = await call(program, { method: 'DELETE', query: { id } })
    eq('a draft is discardable', del.status, 200)
    eq('and the row is gone', tables.client_programs.length, 0)

    // The lead is free again: the same create now succeeds, which is the
    // observable form of "it returned to eligible-leads".
    const again = await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    eq('the lead can be used again', again.status, 201)

    const id2 = tables.client_programs[0].id
    await call(send, { method: 'POST', query: { id: id2 } })
    const delActive = await call(program, { method: 'DELETE', query: { id: id2 } })
    eq('an ACTIVE program is never deleted', [delActive.status, delActive.body?.error], [409, 'not_draft'])
    eq('and it is still there', tables.client_programs.length, 1)
  }

  console.log('\n-- another coach’s program is indistinguishable from missing --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id
    tables.users.push({ id: OTHER_COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })

    for (const [label, handler, method] of [
      ['PATCH', program, 'PATCH'],
      ['DELETE', program, 'DELETE'],
      ['send', send, 'POST'],
    ] as [string, Handler, string][]) {
      const r = await call(handler, { method, query: { id }, body: { status: 'paused' }, user: OTHER_COACH })
      eq(`${label} 404s for another coach`, [r.status, r.body?.error], [404, 'not_found'])
    }
    eq('and the program is untouched', tables.client_programs[0].status, 'draft')
  }

  console.log('\n-- the list, and "due this week" as an aggregate --')
  {
    reset()
    await call(programs, { method: 'POST', body: { lead_id: LEAD, start_date: '2026-01-05' } })
    const id = tables.client_programs[0].id
    await call(send, { method: 'POST', query: { id } })

    // Three things due inside the window, on ONE program. A fold over next_item
    // would report 1 — plausible, and wrong.
    const today = new Date().toISOString().slice(0, 10)
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    const items = tables.client_program_items.filter((i: any) => i.kind === 'milestone')
    for (const i of items) { i.due_date = soon; i.status = 'pending' }

    const r = await call(programs, { method: 'GET' })
    eq('200', r.status, 200)
    eq('one program', r.body?.programs?.length, 1)
    eq('but three things due this week', r.body?.due_this_week, 3)
    ok('while next_item names only one', typeof r.body?.programs?.[0]?.next_item?.id === 'string')
    ok('(today is inside the window)', soon >= today)
  }

  console.log('\n-- method and CORS --')
  {
    for (const [label, handler, bad] of [
      ['/api/client-programs', programs, 'DELETE'],
      ['/api/client-programs/[id]', program, 'POST'],
      ['/api/client-programs/[id]/send', send, 'GET'],
    ] as [string, Handler, string][]) {
      const r = await call(handler, { method: bad, query: { id: 'x' } })
      eq(`${label} 405s the wrong method`, r.status, 405)
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
