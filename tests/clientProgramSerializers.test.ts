// The client-program serializers, and the rules they carry.
//
// The contract document is generated from these functions, so a test that only
// checked key names would be checking the generator. What is checked here is
// the BEHAVIOUR the generator cannot see: which rows count as a used session,
// what "this week" means for a resequenced client, and — most of all — what the
// portal refuses to return.

import {
  serializeProgramSummary,
  serializeProgramDetail,
  serializeClientPortal,
  currentWeek,
  progressCounts,
  sessionsUsed,
  isStalled,
  STALLED_AFTER_DAYS,
  UPCOMING_LIMIT,
  type ProgramRow,
  type ItemRow,
  type NoteRow,
  type SessionRequestRow,
  type ProgramBookingRow,
} from '../lib/clientProgramSerializers'
import { MANAGE_CUTOFF_MS } from '../lib/bookingManage'

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

const program = (over: Partial<ProgramRow> = {}): ProgramRow => ({
  id: 'p1',
  user_id: 'coach-1',
  lead_id: 'lead-1',
  client_name: 'Dana Mercer',
  client_email: 'dana@example.invalid',
  client_timezone: 'America/New_York',
  program_name: 'The Method',
  total_weeks: 6,
  sessions_allowed: 4,
  start_date: '2026-01-01',
  status: 'active',
  portal_token_version: 3,
  portal_last_opened_at: null,
  activated_at: '2026-01-01T09:00:00Z',
  completed_at: null,
  ...over,
})

const item = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: 'i1',
  kind: 'task',
  sequence_position: 1,
  source_week: 1,
  sort_order: 1,
  title: 'A task',
  detail: null,
  phase_name: 'Foundations',
  due_date: null,
  status: 'pending',
  completed_at: null,
  completed_by: null,
  ...over,
})

const booking = (over: Partial<ProgramBookingRow> = {}): ProgramBookingRow => ({
  id: 'b1',
  status: 'active',
  start_time: '2026-02-01T15:00:00Z',
  canceled_at: null,
  ...over,
})

const req = (over: Partial<SessionRequestRow> = {}): SessionRequestRow => ({
  id: 'r1',
  item_id: null,
  note: null,
  preferred_1: null,
  preferred_2: null,
  status: 'requested',
  booking_id: null,
  decline_reason: null,
  created_at: '2026-01-05T09:00:00Z',
  resolved_at: null,
  booking: null,
  ...over,
})

const base = (over: Record<string, any> = {}) => ({
  program: program(),
  items: [] as ItemRow[],
  bookings: [] as ProgramBookingRow[],
  openSessionRequests: 0,
  today: '2026-01-08',
  ...over,
})

console.log('\n-- current_week is a POSITION, and a draft has none --')
{
  eq('day one is week 1', currentWeek(program(), '2026-01-01'), 1)
  eq('day seven is still week 1', currentWeek(program(), '2026-01-07'), 1)
  eq('day eight is week 2', currentWeek(program(), '2026-01-08'), 2)
  // Clamped at both ends: a client who starts late is not in week 0, and one who
  // runs over is not in week 9 of a 6-week programme.
  eq('before the start it clamps to 1', currentWeek(program(), '2025-12-01'), 1)
  eq('past the end it clamps to total_weeks', currentWeek(program(), '2026-06-01'), 6)
  // A draft has not started. Returning 1 would claim it had.
  eq('a draft has no current week', currentWeek(program({ status: 'draft' }), '2026-01-08'), null)

  // Not a source_week. A client starting at their coach's week 4 is in position
  // 1, and reporting 4 would tell them they are three weeks behind on day one.
  const resequenced = [item({ id: 'w', kind: 'week', sequence_position: 1, source_week: 4, sort_order: 0 })]
  const portal = serializeClientPortal({
    ...base({ items: resequenced, today: '2026-01-01' }),
    notes: [], sessionRequests: [], coachFirstName: 'Dana', brand: {},
  })
  eq('the client is in THEIR week 1', portal.program.current_week, 1)
  eq("while this_week reports their coach's week 4", portal.this_week?.source_week, 4)
  // BOTH, in the same object, differing. this_week carries the two numbers side
  // by side, which is the one place they can be swapped without any other
  // assertion noticing — position is where the client IS, source_week is what
  // their coach called it.
  eq('and this_week.sequence_position is the CLIENT position', portal.this_week?.sequence_position, 1)
  ok('so the two numbers are not the same value', portal.this_week?.sequence_position !== portal.this_week?.source_week)
}

console.log('\n-- progress counts the WORK, not the headings --')
{
  const items = [
    item({ id: 'w1', kind: 'week', sequence_position: 1, sort_order: 0 }),
    item({ id: 'w2', kind: 'week', sequence_position: 2, sort_order: 0 }),
    item({ id: 'm1', kind: 'milestone', status: 'completed', completed_at: '2026-01-03T00:00:00Z' }),
    item({ id: 't1', kind: 'task' }),
  ]
  const c = progressCounts(items)
  // 4 rows, 2 of them headings. Counting weeks would report 1/4 = 25% and no
  // client would ever reach 100%.
  eq('two actionable items', c.items_total, 2)
  eq('one done', c.items_completed, 1)
  eq('50%, not 25%', c.progress_pct, 50)

  // A programme with nothing in it has made no progress; 100% would mark it
  // complete the moment it was created.
  eq('0 of 0 is 0%, not NaN', progressCounts([]).progress_pct, 0)
  eq('and not 100%', progressCounts([]).items_total, 0)
}

console.log('\n-- a session is consumed unless it was actively given back --')
{
  const start = '2026-02-01T15:00:00Z'
  const startMs = Date.parse(start)
  const early = new Date(startMs - MANAGE_CUTOFF_MS - 1000).toISOString()
  const exactly = new Date(startMs - MANAGE_CUTOFF_MS).toISOString()
  const late = new Date(startMs - MANAGE_CUTOFF_MS + 1000).toISOString()

  eq('an active booking is used', sessionsUsed([booking()]), 1)
  eq('cancelled in good time is given back', sessionsUsed([booking({ status: 'canceled', canceled_at: early })]), 0)
  // The boundary belongs to the client: cancelling AT the cutoff still returns
  // the session, matching the window api/funnel/booking/cancel.ts allows them.
  eq('exactly at the cutoff is still given back', sessionsUsed([booking({ status: 'canceled', canceled_at: exactly })]), 0)
  eq('a second later is consumed', sessionsUsed([booking({ status: 'canceled', canceled_at: late })]), 1)

  // Pre-094 rows have no timestamp. "Unknown when" must not become "in good
  // time" — charging is the recoverable direction.
  eq('a null canceled_at counts as late', sessionsUsed([booking({ status: 'canceled', canceled_at: null })]), 1)

  // attended is deliberately absent from the formula: every production booking
  // is unmarked, so charging only for a marked no-show is an unlimited allowance
  // for any coach who never marks attendance.
  const unmarked = sessionsUsed([booking(), booking({ id: 'b2', start_time: '2026-02-08T15:00:00Z' })])
  eq('two unmarked calls are two used sessions', unmarked, 2)

  const summary = serializeProgramSummary(base({ bookings: [booking(), booking({ id: 'b2' })] }))
  eq('remaining is allowed minus used', summary.sessions_remaining, 2)
  const over = serializeProgramSummary(base({
    program: program({ sessions_allowed: 1 }),
    bookings: [booking(), booking({ id: 'b2' }), booking({ id: 'b3' })],
  }))
  eq('remaining never goes negative', over.sessions_remaining, 0)
  eq('but used still reports the truth', over.sessions_used, 3)
}

console.log('\n-- stalled needs BOTH halves --')
{
  const overdue = item({ id: 'o', kind: 'task', due_date: '2026-01-01', status: 'pending' })
  const today = '2026-01-20'

  // Overdue alone is a client who is a day late.
  const recent = [overdue, item({ id: 'c', kind: 'task', status: 'completed', completed_at: '2026-01-19T00:00:00Z' })]
  ok('overdue but recently active is NOT stalled', !isStalled(recent, today))

  // Quiet alone is a client between weeks.
  const quiet = [item({ id: 'c', kind: 'task', status: 'completed', completed_at: '2026-01-01T00:00:00Z' })]
  ok('quiet with nothing overdue is NOT stalled', !isStalled(quiet, today))

  // Both together is a programme that has stopped.
  const stalled = [overdue, item({ id: 'c', kind: 'task', status: 'completed', completed_at: '2026-01-05T00:00:00Z' })]
  ok('overdue AND quiet IS stalled', isStalled(stalled, today))
  ok('and nothing ever completed, with something overdue, is stalled', isStalled([overdue], today))

  // The boundary, derived from the constant rather than restated.
  const boundary = new Date(Date.parse(`${today}T00:00:00Z`) - STALLED_AFTER_DAYS * 86_400_000).toISOString()
  ok('exactly at the threshold is stalled', isStalled([overdue, item({ id: 'c', status: 'completed', completed_at: boundary })], today))
  const justInside = new Date(Date.parse(`${today}T00:00:00Z`) - STALLED_AFTER_DAYS * 86_400_000 + 1000).toISOString()
  ok('a second inside it is not', !isStalled([overdue, item({ id: 'c', status: 'completed', completed_at: justInside })], today))
}

console.log('\n-- THE PORTAL: what it refuses to return --')
{
  const notes: NoteRow[] = [
    { id: 'n1', body: 'Shared with you', visibility: 'coach_and_client', created_at: '2026-01-02T00:00:00Z' },
    { id: 'n2', body: 'SECRET coach observation', visibility: 'coach_only', created_at: '2026-01-03T00:00:00Z' },
  ]
  const out = serializeClientPortal({
    ...base({ items: [item({ id: 'w', kind: 'week', sort_order: 0 })] }),
    notes,
    sessionRequests: [],
    coachFirstName: 'Dana',
    brand: { bg: '#020c31' },
  })
  const json = JSON.stringify(out)

  // Asserted by VALUE, not by key name. A key check is blind to the value
  // leaking under a different name, which is the shape of every leak this
  // project has had.
  ok('the coach_only note body is absent', !json.includes('SECRET coach observation'), json)
  eq('only the shared note is returned', out.notes.map((n) => n.id), ['n1'])
  ok('and notes carry no visibility field to leak the other', !('visibility' in (out.notes[0] as any)))

  // Values that exist on the row and must not reach the client.
  for (const [label, value] of [
    ['user_id', 'coach-1'],
    ['lead_id', 'lead-1'],
    ['client_email', 'dana@example.invalid'],
  ] as [string, string][]) {
    ok(`${label} does not appear by value`, !json.includes(value), json)
  }
  // portal_token_version is the client's own credential version.
  ok('portal_token_version is absent', !('portal_token_version' in (out.program as any)))
  ok('and its value is not somewhere else in the payload', !/"portal_token_version"/.test(json))

  // The positive control: a healthy payload DOES carry the things it should, so
  // the absence checks above cannot be satisfied by an empty object.
  eq('the client name is there', out.program.client_name, 'Dana Mercer')
  eq('and the brand is passed through unchanged', out.brand, { bg: '#020c31' })
}

console.log('\n-- upcoming: an item with a confirmed call appears ONCE --')
{
  const linked = item({ id: 'm1', kind: 'milestone', sequence_position: 2, due_date: '2026-01-14', title: 'Week 2 check-in' })
  const other = item({ id: 't2', kind: 'task', sequence_position: 3, due_date: '2026-01-20', title: 'Another task' })
  const confirmed = req({
    id: 'r1', item_id: 'm1', status: 'confirmed', booking_id: 'b1',
    booking: { start_time: '2026-01-14T14:00:00Z', end_time: '2026-01-14T14:30:00Z' },
  })

  const out = serializeClientPortal({
    ...base({ items: [linked, other] }),
    notes: [], sessionRequests: [confirmed], coachFirstName: 'Dana', brand: {},
  })

  eq('two entries, not three', out.upcoming.length, 2)
  const titles = out.upcoming.map((u) => `${u.type}:${u.title}`)
  eq('the milestone appears once, as the session', titles, ['session:Week 2 check-in', 'item:Another task'])
  // Both would be shown otherwise, one of them at a fabricated midnight.
  ok('and never as a bare item too', !titles.includes('item:Week 2 check-in'))

  // An ad-hoc call has no item to name it, and inventing a week number for one
  // would be a lie about which part of the programme it belongs to.
  const adhoc = req({ id: 'r2', item_id: null, status: 'confirmed', booking_id: 'b2', booking: { start_time: '2026-01-10T09:00:00Z', end_time: null } })
  const withAdhoc = serializeClientPortal({
    ...base({ items: [other] }),
    notes: [], sessionRequests: [adhoc], coachFirstName: 'Dana', brand: {},
  })
  eq('an ad-hoc call is labelled by the coach', withAdhoc.upcoming[0].title, 'Call with Dana')
  ok('and carries no sequence_position', !('sequence_position' in (withAdhoc.upcoming[0] as any)))

  // Time-ordered ACROSS the two kinds, which is the only reason to merge them.
  const mixed = serializeClientPortal({
    ...base({ items: [item({ id: 'a', due_date: '2026-01-09', title: 'A' }), item({ id: 'c', due_date: '2026-01-11', title: 'C' })] }),
    notes: [], sessionRequests: [req({ id: 'r3', status: 'confirmed', booking_id: 'b3', booking: { start_time: '2026-01-10T09:00:00Z', end_time: null } })],
    coachFirstName: 'Dana', brand: {},
  })
  eq('a date sorts against a timestamp correctly', mixed.upcoming.map((u) => u.title), ['A', 'Call with Dana', 'C'])

  // Capped, and the cap is the exported constant rather than a second literal.
  const many = Array.from({ length: UPCOMING_LIMIT + 3 }, (_, i) =>
    item({ id: `x${i}`, due_date: `2026-02-0${(i % 9) + 1}`, title: `T${i}` })
  )
  const capped = serializeClientPortal({ ...base({ items: many }), notes: [], sessionRequests: [], coachFirstName: 'Dana', brand: {} })
  eq('capped at UPCOMING_LIMIT', capped.upcoming.length, UPCOMING_LIMIT)

  // Completed work is not upcoming.
  const done = serializeClientPortal({
    ...base({ items: [item({ id: 'd', due_date: '2026-01-09', status: 'completed', completed_at: '2026-01-08T00:00:00Z' })] }),
    notes: [], sessionRequests: [], coachFirstName: 'Dana', brand: {},
  })
  eq('a completed item is not upcoming', done.upcoming.length, 0)
}

console.log('\n-- phases follow the CLIENT’s order, not the snapshot’s --')
{
  // A resequenced client: their position 1 is the coach's week 4.
  const items = [
    item({ id: 'w1', kind: 'week', sequence_position: 1, source_week: 4, sort_order: 0, phase_name: 'Rebuild' }),
    item({ id: 'w2', kind: 'week', sequence_position: 2, source_week: 5, sort_order: 0, phase_name: 'Rebuild' }),
    item({ id: 'w3', kind: 'week', sequence_position: 3, source_week: 1, sort_order: 0, phase_name: 'Foundations' }),
  ]
  const out = serializeClientPortal({
    ...base({ items, today: '2026-01-08' }),
    notes: [], sessionRequests: [], coachFirstName: 'Dana', brand: {},
  })
  // Reading source_week here would show Foundations first — their coach's order,
  // not the journey they are actually on.
  eq('ordered by first appearance in THEIR sequence', out.phases.map((p) => p.phase_name), ['Rebuild', 'Foundations'])
  eq('with their spans', out.phases.map((p) => [p.first_position, p.last_position]), [[1, 2], [3, 3]])
  // today = day 8 -> position 2, inside Rebuild.
  eq('and the state follows the current position', out.phases.map((p) => p.state), ['current', 'upcoming'])

  const later = serializeClientPortal({
    ...base({ items, today: '2026-01-20' }),
    notes: [], sessionRequests: [], coachFirstName: 'Dana', brand: {},
  })
  eq('a finished phase reads done', later.phases.map((p) => p.state), ['done', 'current'])
}

console.log('\n-- the coach detail sees both note visibilities --')
{
  const notes: NoteRow[] = [
    { id: 'n1', body: 'Shared', visibility: 'coach_and_client', created_at: '2026-01-02T00:00:00Z' },
    { id: 'n2', body: 'Private', visibility: 'coach_only', created_at: '2026-01-03T00:00:00Z' },
  ]
  const out = serializeProgramDetail({
    ...base(),
    notes,
    sessionRequests: [req({ status: 'confirmed', booking_id: 'b1', booking: { start_time: '2026-01-14T14:00:00Z', end_time: null } })],
    portalUrl: 'https://example.invalid/p/tok',
    discoveryCallCount: 2,
  })
  eq('both notes reach the coach', out.notes.map((n) => n.id), ['n1', 'n2'])
  eq('with their visibility, which the coach needs to see', out.notes.map((n) => n.visibility), ['coach_and_client', 'coach_only'])
  eq('the portal url is carried', out.program.portal_url, 'https://example.invalid/p/tok')
  eq("and the client's timezone", out.program.client_timezone, 'America/New_York')
  eq('the confirmed booking time is exposed', out.session_requests[0].booking?.start_time, '2026-01-14T14:00:00Z')

  // Display only. The same (coach, email) match the schema calls a trap, used
  // deliberately here and never in the allowance.
  eq('discovery calls are reported', out.discovery_call_count, 2)
  eq('and are NOT in sessions_used', out.program.sessions_used, 0)
}

console.log('\n-- next_item is the soonest pending work --')
{
  const items = [
    item({ id: 'far', due_date: '2026-03-01' }),
    item({ id: 'soon', due_date: '2026-01-09' }),
    item({ id: 'done', due_date: '2026-01-02', status: 'completed', completed_at: '2026-01-02T00:00:00Z' }),
    item({ id: 'heading', kind: 'week', due_date: '2026-01-01', sort_order: 0 }),
  ]
  const s = serializeProgramSummary(base({ items }))
  eq('the soonest PENDING item wins', s.next_item?.id, 'soon')
  // A week row is a heading with no work in it, and a completed item is done.
  ok('not a heading and not a completed item', s.next_item?.id !== 'heading' && s.next_item?.id !== 'done')

  const undatedOnly = serializeProgramSummary(base({ items: [item({ id: 'u1', sequence_position: 3 }), item({ id: 'u2', sequence_position: 2 })] }))
  eq('with nothing dated, position order decides', undatedOnly.next_item?.id, 'u2')
  eq('and its due_date is null rather than invented', undatedOnly.next_item?.due_date, null)

  eq('nothing pending means no next item', serializeProgramSummary(base()).next_item, null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
