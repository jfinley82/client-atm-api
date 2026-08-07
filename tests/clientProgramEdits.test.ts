// Step 7b: the endpoints that reshape a plan after it exists.
//
// Same constraint-enforcing stub as tests/clientProgramWrites.test.ts, because
// every one of these writes against a real index or CHECK — most of all the
// partial unique index on open session requests, which is the whole reason a
// request can be confirmed, declined, withdrawn and re-requested without the
// second one colliding with the first.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
import { checkWrite, applyDefaults, CLIENT_PROGRAM_CONSTRAINTS, PG_UNIQUE_VIOLATION } from './support/pgConstraints'
import { createSessionToken } from '../lib/auth'
import { derivedDueDate } from '../lib/clientProgramPlan'

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
const PROGRAM = 'prog-1'
const OTHER_PROGRAM = 'prog-2'
const START = '2026-01-05'

let tables: Record<string, any[]> = {}
let resendCancels: string[] = []
let seq = 0

// Three positions, week + milestone each — what planFromSnapshot produces.
function planRows() {
  const rows: any[] = []
  for (const p of [1, 2, 3]) {
    rows.push({ id: `w${p}`, program_id: PROGRAM, kind: 'week', sequence_position: p, source_week: p, sort_order: 0, title: `Week ${p}`, detail: null, phase_name: p < 3 ? 'Foundations' : 'Launch', due_date: null, due_date_source: 'derived', status: 'pending', completed_at: null, completed_by: null, reminder_message_id: null })
    rows.push({ id: `m${p}`, program_id: PROGRAM, kind: 'milestone', sequence_position: p, source_week: p, sort_order: 1, title: `Milestone ${p}`, detail: null, phase_name: p < 3 ? 'Foundations' : 'Launch', due_date: derivedDueDate(START, p), due_date_source: 'derived', status: 'pending', completed_at: null, completed_by: null, reminder_message_id: `msg-${p}` })
  }
  return rows
}

function reset(over: Record<string, any> = {}) {
  seq = 0
  resendCancels = []
  tables = {
    users: [
      { id: COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
      { id: OTHER_COACH, status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
    ],
    client_programs: [
      { id: PROGRAM, user_id: COACH, lead_id: null, client_name: 'Dana', client_email: 'dana@example.invalid', client_timezone: 'America/New_York', program_snapshot: {}, program_name: 'The Method', total_weeks: 3, sessions_allowed: 2, start_date: START, status: 'active', portal_token_version: 1, portal_last_opened_at: null, activated_at: '2026-01-05T09:00:00Z', completed_at: null, ...over },
      { id: OTHER_PROGRAM, user_id: OTHER_COACH, lead_id: null, client_name: 'Someone', client_email: 'x@example.invalid', client_timezone: null, program_snapshot: {}, program_name: 'Theirs', total_weeks: 2, sessions_allowed: 2, start_date: START, status: 'active', portal_token_version: 1, portal_last_opened_at: null, activated_at: null, completed_at: null },
    ],
    client_program_items: planRows(),
    client_program_notes: [],
    client_program_session_requests: [],
    bookings: [],
    funnel_email_sends: [],
  }
}

const tableOf = (url: string) => /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? ''
function wantsObject(init: any): boolean {
  const h = init?.headers
  const accept = h && typeof h.get === 'function' ? h.get('Accept') : h?.Accept ?? h?.accept
  return /vnd\.pgrst\.object/.test(String(accept || ''))
}
function matches(url: string, row: Record<string, any>): boolean {
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=eq\.([^&]+)/g)) {
    if (['select', 'order', 'limit'].includes(key)) continue
    if (String(row[key]) !== val) return false
  }
  for (const [, key, val] of url.matchAll(/[?&]([a-z_]+)=ilike\.([^&]+)/g)) {
    if (String(row[key] ?? '').toLowerCase() !== val.toLowerCase()) return false
  }
  for (const [, key] of url.matchAll(/[?&]([a-z_]+)=is\.null/g)) {
    if (row[key] !== null && row[key] !== undefined) return false
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

  if (url.includes('api.resend.com/emails/')) {
    resendCancels.push(url.split('/emails/')[1].replace(/\/cancel.*$/, ''))
    return json({ id: 'canceled' })
  }

  const table = tableOf(url)
  if (!table) return json([])
  tables[table] = tables[table] || []

  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body]
    const staged: any[] = []
    for (const raw of rows) {
      const constraints = CLIENT_PROGRAM_CONSTRAINTS[table]
      const row = applyDefaults({ id: raw.id ?? `${table}-${++seq}`, ...raw }, constraints)
      if (constraints) {
        const violation = checkWrite(table, row, constraints, [...tables[table], ...staged], tables)
        if (violation) return json(violation, violation.code === PG_UNIQUE_VIOLATION ? 409 : 400)
      }
      staged.push(row)
    }
    tables[table].push(...staged)
    return json(wantsObject(init) ? staged[0] ?? null : staged)
  }

  if (method === 'PATCH') {
    const hit = tables[table].filter((r) => matches(url, r))
    for (const r of hit) {
      const constraints = CLIENT_PROGRAM_CONSTRAINTS[table]
      const next = { ...r, ...body }
      // UPDATES ARE CONSTRAINED TOO. A patch that moves a request back to
      // `requested` beside another open one is a unique violation, and a fake
      // that only checked inserts would let it through.
      if (constraints) {
        const violation = checkWrite(table, next, constraints, tables[table], tables)
        if (violation) return json(violation, violation.code === PG_UNIQUE_VIOLATION ? 409 : 400)
      }
      Object.assign(r, body)
    }
    return json(wantsObject(init) ? hit[0] ?? null : hit)
  }

  if (method === 'DELETE') {
    const before = tables[table].length
    tables[table] = tables[table].filter((r) => !matches(url, r))
    return json(new Array(before - tables[table].length).fill({}))
  }

  const rows = tables[table].filter((r) => matches(url, r))
  if (/[?&]select=id&/.test(url) || /count/.test(String(init?.headers?.Prefer || ''))) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
    })
  }
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
  await handler({ method: opts.method || 'GET', headers: { authorization: `Bearer ${token}` }, query: opts.query || {}, body: opts.body ?? null } as any, res)
  return { status, body: out }
}

const items = () => tables.client_program_items.slice().sort((a, b) => a.sequence_position - b.sequence_position || a.sort_order - b.sort_order)
const positions = () => items().map((i) => `${i.id}@${i.sequence_position}`)

;(async () => {
  const { default: detail } = await import('../api/client-programs/[id]')
  const { default: resequence } = await import('../api/client-programs/[id]/resequence')
  const { default: itemsRoute } = await import('../api/client-programs/[id]/items/index')
  const { default: itemRoute } = await import('../api/client-programs/[id]/items/[itemId]')
  const { default: notesRoute } = await import('../api/client-programs/[id]/notes/index')
  const { default: noteRoute } = await import('../api/client-programs/[id]/notes/[noteId]')
  const { default: requestRoute } = await import('../api/client-programs/[id]/requests/[requestId]')

  const q = { id: PROGRAM }

  console.log('\n-- RESEQUENCE: rejected whole, or not at all --')
  {
    reset()
    const before = positions()

    for (const [label, payload] of [
      ['a gap', [{ item_id: 'w1', sequence_position: 1 }, { item_id: 'm1', sequence_position: 1 }, { item_id: 'w2', sequence_position: 3 }, { item_id: 'm2', sequence_position: 3 }, { item_id: 'w3', sequence_position: 4 }, { item_id: 'm3', sequence_position: 4 }]],
      ['not starting at 1', [{ item_id: 'w1', sequence_position: 2 }, { item_id: 'm1', sequence_position: 2 }, { item_id: 'w2', sequence_position: 3 }, { item_id: 'm2', sequence_position: 3 }, { item_id: 'w3', sequence_position: 4 }, { item_id: 'm3', sequence_position: 4 }]],
      ['a duplicate item', [{ item_id: 'w1', sequence_position: 1 }, { item_id: 'w1', sequence_position: 2 }]],
      ['an item from another program', [{ item_id: 'nope', sequence_position: 1 }]],
      ['an incomplete payload', [{ item_id: 'w1', sequence_position: 1 }]],
      ['position zero', [{ item_id: 'w1', sequence_position: 0 }, { item_id: 'm1', sequence_position: 1 }, { item_id: 'w2', sequence_position: 1 }, { item_id: 'm2', sequence_position: 2 }, { item_id: 'w3', sequence_position: 2 }, { item_id: 'm3', sequence_position: 2 }]],
    ] as [string, any][]) {
      const r = await call(resequence, { method: 'PATCH', query: q, body: { positions: payload } })
      eq(`${label} is 400 invalid_sequence`, [r.status, r.body?.error], [400, 'invalid_sequence'])
    }
    // RE-READ EVERY ITEM. "Rejected" has to mean nothing moved, not that the
    // response said no while half the payload landed.
    eq('and NOTHING moved across all six rejections', positions(), before)

    // THE TWO ABOVE THAT THE COVERAGE CHECK WAS ANSWERING FOR. Every payload so
    // far fails `seen.size === items.length` as well, so deleting the duplicate
    // guard or the unknown-id guard changed nothing — both were caught by a
    // different rule. These two payloads pass coverage and contiguity, leaving
    // only the guard under test.
    const dupCovered = [
      { item_id: 'w1', sequence_position: 1 }, { item_id: 'm1', sequence_position: 1 },
      { item_id: 'w2', sequence_position: 2 }, { item_id: 'm2', sequence_position: 2 },
      { item_id: 'w3', sequence_position: 3 }, { item_id: 'm3', sequence_position: 3 },
      // ...and w1 again, at a different position. Coverage still sees six ids.
      { item_id: 'w1', sequence_position: 3 },
    ]
    const dup = await call(resequence, { method: 'PATCH', query: q, body: { positions: dupCovered } })
    eq('a duplicate that still covers every item is refused', [dup.status, dup.body?.reason], [400, 'duplicate item_id'])

    const foreignCovered = [
      // Six entries, so coverage passes — but one names a row from no program
      // and one real item is therefore missing. Without the byId check that item
      // gets `sequence_position: undefined`.
      { item_id: 'w1', sequence_position: 1 }, { item_id: 'm1', sequence_position: 1 },
      { item_id: 'w2', sequence_position: 2 }, { item_id: 'm2', sequence_position: 2 },
      { item_id: 'w3', sequence_position: 3 }, { item_id: 'ghost', sequence_position: 3 },
    ]
    const foreign = await call(resequence, { method: 'PATCH', query: q, body: { positions: foreignCovered } })
    eq('an unknown id that still covers the count is refused', [foreign.status, foreign.body?.reason], [400, 'unknown item_id'])

    eq('and still nothing moved', positions(), before)
  }

  console.log('\n-- RESEQUENCE: a valid reorder moves positions and dates, not source_week --')
  {
    reset()
    // Reverse the plan: the client starts at their coach's week 3.
    const payload = [
      { item_id: 'w3', sequence_position: 1 }, { item_id: 'm3', sequence_position: 1 },
      { item_id: 'w2', sequence_position: 2 }, { item_id: 'm2', sequence_position: 2 },
      { item_id: 'w1', sequence_position: 3 }, { item_id: 'm1', sequence_position: 3 },
    ]
    const r = await call(resequence, { method: 'PATCH', query: q, body: { positions: payload } })
    eq('200', r.status, 200)

    const m3 = tables.client_program_items.find((i: any) => i.id === 'm3')
    eq('the coach’s week 3 is now position 1', m3.sequence_position, 1)
    // THE POINT OF TWO COLUMNS: their journey renumbers, their coach's method
    // does not.
    eq('and source_week still reads 3', m3.source_week, 3)
    eq('its due date follows the POSITION', m3.due_date, derivedDueDate(START, 1))

    const m1 = tables.client_program_items.find((i: any) => i.id === 'm1')
    eq('the old first milestone is last', [m1.sequence_position, m1.source_week], [3, 1])
    eq('dated from position 3', m1.due_date, derivedDueDate(START, 3))
  }

  console.log('\n-- RESEQUENCE leaves manual dates alone --')
  {
    reset()
    const m2 = tables.client_program_items.find((i: any) => i.id === 'm2')
    m2.due_date = '2026-06-01'
    m2.due_date_source = 'manual'
    await call(resequence, { method: 'PATCH', query: q, body: { positions: [
      { item_id: 'w3', sequence_position: 1 }, { item_id: 'm3', sequence_position: 1 },
      { item_id: 'w2', sequence_position: 2 }, { item_id: 'm2', sequence_position: 2 },
      { item_id: 'w1', sequence_position: 3 }, { item_id: 'm1', sequence_position: 3 },
    ] } })
    eq('the manual date survived', tables.client_program_items.find((i: any) => i.id === 'm2').due_date, '2026-06-01')
    eq('while a derived sibling moved', tables.client_program_items.find((i: any) => i.id === 'm3').due_date, derivedDueDate(START, 1))
  }

  console.log('\n-- ITEMS: add, and refuse to add a second heading --')
  {
    reset()
    const bad = await call(itemsRoute, { method: 'POST', query: q, body: { kind: 'week', sequence_position: 1, title: 'Second heading' } })
    eq('kind:week is refused', [bad.status, bad.body?.field], [400, 'kind'])

    const r = await call(itemsRoute, { method: 'POST', query: q, body: { kind: 'task', sequence_position: 2, title: 'Do the thing' } })
    eq('201', r.status, 201)
    // A coach-added task came from no snapshot week; stamping one would claim
    // their method contains it.
    eq('source_week is null', r.body?.item?.source_week, null)
    eq('and it is dated from its position', r.body?.item?.due_date, derivedDueDate(START, 2))
    eq('derived, because the coach did not type it', r.body?.item?.due_date_source, 'derived')
    ok('sorted after the heading', r.body?.item?.sort_order > 0)

    const manual = await call(itemsRoute, { method: 'POST', query: q, body: { kind: 'task', sequence_position: 2, title: 'Dated', due_date: '2026-05-05' } })
    eq('an explicit date is MANUAL from the start', [manual.body?.item?.due_date, manual.body?.item?.due_date_source], ['2026-05-05', 'manual'])
  }

  console.log('\n-- ITEMS: due_date_source is two-way, so a coach can undo --')
  {
    reset()
    await call(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'm2' }, body: { due_date: '2026-06-01' } })
    let m2 = tables.client_program_items.find((i: any) => i.id === 'm2')
    eq('setting a date makes it manual', [m2.due_date, m2.due_date_source], ['2026-06-01', 'manual'])

    // Without this the column is one-way and undoing means deleting the item.
    await call(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'm2' }, body: { due_date: null } })
    m2 = tables.client_program_items.find((i: any) => i.id === 'm2')
    eq('clearing it returns the row to derived', [m2.due_date, m2.due_date_source], [derivedDueDate(START, 2), 'derived'])
  }

  console.log('\n-- ITEMS: completion records WHO --')
  {
    reset()
    await call(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'm1' }, body: { status: 'completed' } })
    const m1 = tables.client_program_items.find((i: any) => i.id === 'm1')
    eq('completed by the coach', m1.completed_by, 'coach')
    ok('and stamped', typeof m1.completed_at === 'string')

    await call(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'm1' }, body: { status: 'pending' } })
    const back = tables.client_program_items.find((i: any) => i.id === 'm1')
    eq('un-completing clears both', [back.completed_at, back.completed_by], [null, null])

    const bad = await call(itemRoute, { method: 'PATCH', query: { ...q, itemId: 'm1' }, body: { kind: 'week' } })
    eq('kind is not patchable', [bad.status, bad.body?.field], [400, 'kind'])
  }

  console.log('\n-- DELETING A WEEK COMPACTS, and cancels its reminders first --')
  {
    reset()
    const r = await call(itemRoute, { method: 'DELETE', query: { ...q, itemId: 'w2' } })
    eq('200', r.status, 200)
    eq('compacted', r.body?.compacted, true)

    // The whole position goes, not just the heading.
    eq('both rows at position 2 are gone', tables.client_program_items.filter((i: any) => ['w2', 'm2'].includes(i.id)).length, 0)

    // A deleted task whose reminder is still queued emails the client about work
    // that no longer exists — and once the row is gone there is no message id
    // left to find.
    eq('its reminder was cancelled at Resend', resendCancels, ['msg-2'])

    // NO GAP. 1,2,3,4,6,7 is a state resequence's own contiguity rule rejects —
    // reachable through the API and refused by the API.
    eq('positions are contiguous', [...new Set(items().map((i: any) => i.sequence_position))], [1, 2])
    const m3 = tables.client_program_items.find((i: any) => i.id === 'm3')
    eq('the later position moved up', m3.sequence_position, 2)
    eq('and its derived date moved with it', m3.due_date, derivedDueDate(START, 2))
    eq('source_week is untouched by compaction', m3.source_week, 3)
  }

  console.log('\n-- compaction respects manual dates too --')
  {
    reset()
    const m3 = tables.client_program_items.find((i: any) => i.id === 'm3')
    m3.due_date = '2026-06-01'
    m3.due_date_source = 'manual'
    await call(itemRoute, { method: 'DELETE', query: { ...q, itemId: 'w1' } })
    const after = tables.client_program_items.find((i: any) => i.id === 'm3')
    eq('it moved position', after.sequence_position, 2)
    eq('but kept the coach’s date', after.due_date, '2026-06-01')
  }

  console.log('\n-- deleting a NON-week row takes only that row --')
  {
    reset()
    const r = await call(itemRoute, { method: 'DELETE', query: { ...q, itemId: 'm2' } })
    eq('not compacted', r.body?.compacted, false)
    eq('its reminder still cancelled', resendCancels, ['msg-2'])
    eq('the heading survives', tables.client_program_items.filter((i: any) => i.id === 'w2').length, 1)
    eq('and nothing renumbered', [...new Set(items().map((i: any) => i.sequence_position))], [1, 2, 3])
  }

  console.log('\n-- NOTES: visibility is required, then immutable --')
  {
    reset()
    const missing = await call(notesRoute, { method: 'POST', query: q, body: { body: 'A note' } })
    eq('no visibility is 400 visibility_required', [missing.status, missing.body?.error], [400, 'visibility_required'])
    eq('and nothing was written', tables.client_program_notes.length, 0)

    const bad = await call(notesRoute, { method: 'POST', query: q, body: { body: 'A note', visibility: 'public' } })
    eq('an unknown visibility is refused', [bad.status, bad.body?.field], [400, 'visibility'])

    const created = await call(notesRoute, { method: 'POST', query: q, body: { body: 'Private', visibility: 'coach_only' } })
    eq('201', created.status, 201)
    const noteId = created.body?.note?.id

    // UN-SHARING DOES NOT UNSEE, and the reverse cannot be re-consented to.
    const flip = await call(noteRoute, { method: 'PATCH', query: { ...q, noteId }, body: { visibility: 'coach_and_client' } })
    eq('visibility cannot be patched', [flip.status, flip.body?.field], [400, 'visibility'])
    eq('and it did not change', tables.client_program_notes[0].visibility, 'coach_only')

    const edited = await call(noteRoute, { method: 'PATCH', query: { ...q, noteId }, body: { body: 'Reworded' } })
    eq('the body can be edited', [edited.status, tables.client_program_notes[0].body], [200, 'Reworded'])

    const gone = await call(noteRoute, { method: 'DELETE', query: { ...q, noteId } })
    eq('retracting is DELETE', [gone.status, tables.client_program_notes.length], [200, 0])
  }

  console.log('\n-- SESSION REQUESTS: every legal state, in sequence --')
  {
    // The states a request can reach are requested -> confirmed | declined |
    // withdrawn, and a program can cycle through several. The partial unique
    // index only constrains the OPEN one, which is what makes the cycle legal —
    // and a fake that enforced it unconditionally would refuse the second
    // request that this whole design exists to allow.
    reset()
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: 'm1', note: null, preferred_1: null, preferred_2: null, status: 'requested', booking_id: null, decline_reason: null, created_at: '2026-01-06T09:00:00Z', resolved_at: null })

    const declined = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'decline', decline_reason: 'No slots that week' } })
    eq('declining resolves it', [declined.status, tables.client_program_session_requests[0].status], [200, 'declined'])
    ok('with a timestamp', typeof tables.client_program_session_requests[0].resolved_at === 'string')
    eq('and the reason', tables.client_program_session_requests[0].decline_reason, 'No slots that week')

    // The index is freed, so a second request is legal. This is the assertion
    // the partial predicate exists for.
    const second = await fetch('https://stub.supabase.co/rest/v1/client_program_session_requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'r2', program_id: PROGRAM, status: 'requested' }),
    })
    eq('a second request is accepted once the first resolved', second.status, 200)

    // ...and a THIRD, while r2 is open, is not.
    const third = await fetch('https://stub.supabase.co/rest/v1/client_program_session_requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'r3', program_id: PROGRAM, status: 'requested' }),
    })
    eq('but a second OPEN one is refused by the index', third.status, 409)

    // A resolved request is not actionable — confirming a declined one would
    // book a call nobody is currently asking for.
    const reDecline = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'decline' } })
    eq('re-resolving a closed request is 409', [reDecline.status, reDecline.body?.error], [409, 'not_open'])

    // CONFIRMING one is the dangerous half: the booking is created before the
    // status update can refuse, so the compensating delete is the only thing
    // between a declined request and an orphan booking that consumes a session.
    const bookingsBefore = tables.bookings.length
    const reConfirm = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'confirm', start_time: '2026-01-20T14:00:00Z', end_time: '2026-01-20T14:30:00Z' } })
    eq('confirming a closed request is 409', [reConfirm.status, reConfirm.body?.error], [409, 'not_open'])
    eq('and leaves NO booking behind', tables.bookings.length, bookingsBefore)
  }

  console.log('\n-- CONFIRM: the allowance is re-checked immediately before the write --')
  {
    reset()
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: 'm1', note: null, preferred_1: null, preferred_2: null, status: 'requested', booking_id: null, decline_reason: null, created_at: '2026-01-06T09:00:00Z', resolved_at: null })

    const r = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'confirm', start_time: '2026-01-15T14:00:00Z', end_time: '2026-01-15T14:30:00Z' } })
    eq('200', r.status, 200)
    eq('the request is confirmed', tables.client_program_session_requests[0].status, 'confirmed')
    eq('a booking exists', tables.bookings.length, 1)
    // THE ONLY PLACE program_id IS SET. Discovery calls are excluded from the
    // allowance because they were never in the set, not because a filter removes
    // them.
    eq('and it carries program_id', tables.bookings[0].program_id, PROGRAM)
    eq('linked back on the request', tables.client_program_session_requests[0].booking_id, tables.bookings[0].id)
    ok('and resolved_at is stamped', typeof tables.client_program_session_requests[0].resolved_at === 'string')
  }

  console.log('\n-- CONFIRM refuses once the allowance is gone, and leaves the request open --')
  {
    reset()
    tables.client_programs[0].sessions_allowed = 1
    tables.bookings.push({ id: 'b-used', program_id: PROGRAM, status: 'active', start_time: '2026-01-10T14:00:00Z', canceled_at: null })
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: null, note: null, preferred_1: null, preferred_2: null, status: 'requested', booking_id: null, decline_reason: null, created_at: '2026-01-06T09:00:00Z', resolved_at: null })

    const r = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'confirm', start_time: '2026-01-15T14:00:00Z', end_time: '2026-01-15T14:30:00Z' } })
    eq('409 no_sessions_remaining', [r.status, r.body?.error], [409, 'no_sessions_remaining'])
    eq('no booking was created', tables.bookings.length, 1)
    // LEFT OPEN so the coach can see why, rather than silently declined.
    eq('and the request is still open', tables.client_program_session_requests[0].status, 'requested')

    // A session given back in good time is NOT consumed, so the same confirm
    // then succeeds — proving the check reads the rule rather than a counter.
    tables.bookings[0].status = 'canceled'
    tables.bookings[0].canceled_at = '2026-01-09T14:00:00Z'
    const retry = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body: { action: 'confirm', start_time: '2026-01-15T14:00:00Z', end_time: '2026-01-15T14:30:00Z' } })
    eq('once the session is given back, confirm succeeds', retry.status, 200)
  }

  console.log('\n-- CONFIRM validates the times --')
  {
    reset()
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: null, note: null, preferred_1: null, preferred_2: null, status: 'requested', booking_id: null, decline_reason: null, created_at: '2026-01-06T09:00:00Z', resolved_at: null })
    for (const [label, body] of [
      ['a missing start', { action: 'confirm', end_time: '2026-01-15T14:30:00Z' }],
      ['a non-ISO start', { action: 'confirm', start_time: '2026-01-15', end_time: '2026-01-15T14:30:00Z' }],
      ['an end before the start', { action: 'confirm', start_time: '2026-01-15T14:30:00Z', end_time: '2026-01-15T14:00:00Z' }],
      ['an unknown action', { action: 'maybe' }],
    ] as [string, any][]) {
      const r = await call(requestRoute, { method: 'POST', query: { ...q, requestId: 'r1' }, body })
      eq(label, r.status, 400)
    }
    eq('and no booking was written', tables.bookings.length, 0)
    eq('the request is still open', tables.client_program_session_requests[0].status, 'requested')
  }

  console.log('\n-- every child route checks the PARENT and the CHILD --')
  {
    reset()
    // A child id that exists, but under another coach's program. The program in
    // the URL is the one being authorized, so without the second check this row
    // would be editable by whoever could name it.
    tables.client_program_notes.push({ id: 'note-theirs', program_id: OTHER_PROGRAM, body: 'Theirs', visibility: 'coach_only', created_at: '2026-01-06T09:00:00Z' })
    tables.client_program_items.push({ id: 'item-theirs', program_id: OTHER_PROGRAM, kind: 'task', sequence_position: 1, source_week: null, sort_order: 1, title: 'Theirs', detail: null, phase_name: null, due_date: null, due_date_source: 'derived', status: 'pending', completed_at: null, completed_by: null, reminder_message_id: null })

    const note = await call(noteRoute, { method: 'PATCH', query: { ...q, noteId: 'note-theirs' }, body: { body: 'hacked' } })
    eq('a note from another program 404s', [note.status, note.body?.error], [404, 'not_found'])
    eq('and is unchanged', tables.client_program_notes[0].body, 'Theirs')

    const item = await call(itemRoute, { method: 'DELETE', query: { ...q, itemId: 'item-theirs' } })
    eq('an item from another program 404s', item.status, 404)
    ok('and survives', tables.client_program_items.some((i: any) => i.id === 'item-theirs'))

    // And the parent check itself.
    for (const [label, handler, method, query] of [
      ['detail', detail, 'GET', { id: OTHER_PROGRAM }],
      ['resequence', resequence, 'PATCH', { id: OTHER_PROGRAM }],
      ['item create', itemsRoute, 'POST', { id: OTHER_PROGRAM }],
      ['note create', notesRoute, 'POST', { id: OTHER_PROGRAM }],
    ] as [string, Handler, string, any][]) {
      const r = await call(handler, { method, query, body: { positions: [], kind: 'task', sequence_position: 1, title: 'x', body: 'x', visibility: 'coach_only' } })
      eq(`${label} 404s on another coach’s program`, r.status, 404)
    }
  }

  console.log('\n-- the detail payload comes from the serializer --')
  {
    reset()
    tables.client_program_notes.push(
      { id: 'n1', program_id: PROGRAM, body: 'Shared', visibility: 'coach_and_client', created_at: '2026-01-06T09:00:00Z' },
      { id: 'n2', program_id: PROGRAM, body: 'Private', visibility: 'coach_only', created_at: '2026-01-07T09:00:00Z' }
    )
    tables.bookings.push({ id: 'b1', program_id: PROGRAM, status: 'active', start_time: '2026-01-15T14:00:00Z', end_time: '2026-01-15T14:30:00Z', canceled_at: null })
    tables.client_program_session_requests.push({ id: 'r1', program_id: PROGRAM, item_id: 'm1', note: null, preferred_1: null, preferred_2: null, status: 'confirmed', booking_id: 'b1', decline_reason: null, created_at: '2026-01-06T09:00:00Z', resolved_at: '2026-01-06T10:00:00Z' })

    const r = await call(detail, { method: 'GET', query: q })
    eq('200', r.status, 200)
    eq('items are there', r.body?.items?.length, 6)
    // BOTH visibilities — this is the coach path.
    eq('both notes reach the coach', r.body?.notes?.map((n: any) => n.id), ['n1', 'n2'])
    // due_date is a date with no time; the instant lives on the booking.
    eq('a confirmed request carries its booking time', r.body?.session_requests?.[0]?.booking?.start_time, '2026-01-15T14:00:00Z')
    eq('sessions_used counts the program booking', r.body?.program?.sessions_used, 1)
    ok('and a portal url is minted', typeof r.body?.program?.portal_url === 'string' && r.body.program.portal_url.includes('/p/'))
  }

  console.log('\n-- method guards --')
  {
    for (const [label, handler] of [
      ['resequence', resequence], ['items', itemsRoute], ['item', itemRoute],
      ['notes', notesRoute], ['note', noteRoute], ['request', requestRoute],
    ] as [string, Handler][]) {
      const r = await call(handler, { method: 'HEAD', query: { ...q, itemId: 'm1', noteId: 'n1', requestId: 'r1' } })
      eq(`${label} 405s the wrong method`, r.status, 405)
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
