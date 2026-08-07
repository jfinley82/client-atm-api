process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ZOOM_ACCOUNT_ID = 'a'
process.env.ZOOM_CLIENT_ID = 'b'
process.env.ZOOM_CLIENT_SECRET = 'c'
process.env.ZOOM_SCHEDULE_ID = 'sched'
process.env.RESEND_API_KEY = 'stub-resend'

import { projectSelect } from './support/postgrest'
import { bookingTimeLabel, isValidTimeZone, normalizeTimeZone } from '../lib/bookingTimezone'
import { BOOKING_TYPE_ANSWER_ID, BOOKING_TYPE_LABEL, resolveBookingType } from '../lib/bookingQuestions'

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

// The real booking the brief references, as the reference shape.
const REFERENCE_ANSWERS = [
  { id: 'q_challenge', type: 'single_line', label: "What's your biggest challenge getting clients?", answer: 'a' },
  { id: 'q_goal', type: 'multi_line', label: 'What do you want to accomplish in the next 90 days?', answer: 'b' },
  { id: 'q_revenue', type: 'dropdown', label: "What's your current monthly revenue?", answer: '$10k+' },
]
const REFERENCE_QUESTIONS = [
  { id: 'q_challenge', label: REFERENCE_ANSWERS[0].label, type: 'single_line', required: true, order: 0 },
  { id: 'q_goal', label: REFERENCE_ANSWERS[1].label, type: 'multi_line', required: true, order: 1 },
  { id: 'q_revenue', label: REFERENCE_ANSWERS[2].label, type: 'dropdown', required: true, options: ['$10k+'], order: 2 },
]

// 2026-08-18 23:30Z is 6:30 PM America/Chicago — the exact instant from the
// reference booking, and the one the email rendered as 11:30 PM.
const START_ISO = '2026-08-18T23:30:00.000Z'

let configuredTypes: string[] | null = null
let inserted: any = null
let sentEmails: Array<Record<string, unknown>> = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('zoom.us/oauth/token')) return json({ access_token: 't', expires_in: 3600 })
  if (url.includes('available_times')) {
    return json({ duration: 30, days: [{ spots: [{ start_time: START_ISO, status: 'available' }] }] })
  }
  if (url.includes('api.zoom.us/v2/users') || url.includes('/meetings')) {
    return json({ id: '999', join_url: 'https://zoom.us/j/999', start_time: START_ISO })
  }
  if (url.includes('/rest/v1/app_settings')) {
    const rows: any[] = [{ key: 'booking_questions', value: JSON.stringify(REFERENCE_QUESTIONS) }]
    if (configuredTypes) rows.push({ key: 'booking_types', value: JSON.stringify(configuredTypes) })
    if (url.includes('key=eq.booking_types')) return json(configuredTypes ? { value: JSON.stringify(configuredTypes) } : null)
    // The global phone toggle: unset, which reads as not-required so /book keeps
    // working until the frontend ships the field.
    if (url.includes('key=eq.booking_phone_required')) return json(null)
    if (url.includes('key=eq.booking_questions')) return json({ value: JSON.stringify(REFERENCE_QUESTIONS) })
    return json(rows)
  }
  if (url.includes('/rest/v1/bookings')) {
    if (method === 'POST') {
      inserted = Array.isArray(body) ? body[0] : body
      return json({ id: 'booking-1' })
    }
    return json([])
  }
  if (url.includes('resend.com')) {
    sentEmails.push((body || {}) as Record<string, unknown>)
    return json({ id: 'email-1' })
  }
  return json({})
}) as typeof fetch

function makeRes() {
  const out: any = { status: 0, body: null }
  const res: any = {
    setHeader() {},
    status(c: number) {
      out.status = c
      return res
    },
    json(v: unknown) {
      out.body = v
      return res
    },
    end() {
      return res
    },
  }
  return { res, out }
}

;(async () => {
  const book: Handler = (await import('../api/calendar/book')).default

  async function makeBooking(extra: Record<string, unknown> = {}) {
    inserted = null
    sentEmails = []
    const r = makeRes()
    await book(
      {
        method: 'POST',
        headers: {},
        query: {},
        body: {
          slot_start: START_ISO,
          first_name: 'Test',
          last_name: 'Visitor',
          email: 'visitor@example.com',
          answers: { q_challenge: 'a', q_goal: 'b', q_revenue: '$10k+' },
          ...extra,
        },
      },
      r.res
    )
    return { status: r.out.status, body: r.out.body, row: inserted, emails: sentEmails }
  }

  console.log('\n-- Gap 1: the booking type is stored, first, in the shape the others use --')
  {
    configuredTypes = ['Discovery Call', 'Strategy Session']
    const b = await makeBooking({ booking_type: 'Strategy Session' })
    ok('the booking succeeds', b.status === 200, `${b.status} ${JSON.stringify(b.body)}`)
    const answers = b.row?.custom_answers || []
    ok('four entries are stored, not three', answers.length === 4, JSON.stringify(answers))
    ok('the type is FIRST', answers[0]?.id === BOOKING_TYPE_ANSWER_ID, JSON.stringify(answers[0]))
    ok(
      'in the exact shape the brief specified',
      answers[0]?.id === 'booking_type' &&
        answers[0]?.type === 'dropdown' &&
        answers[0]?.label === 'What kind of call is this?' &&
        answers[0]?.answer === 'Strategy Session',
      JSON.stringify(answers[0])
    )
    // Acceptance 6 — the three existing answers unchanged against 937c0f16.
    // Compared FIELD BY FIELD, not stringified: jsonb does not preserve key
    // insertion order (it sorts by key length then lexicographically, which is
    // why the production row reads id/type/label/answer), so a string compare
    // would assert Postgres's storage order rather than our content.
    const rest = answers.slice(1)
    ok(
      'and the three existing answers match the reference field for field',
      rest.length === 3 &&
        rest.every(
          (a: any, i: number) =>
            a.id === REFERENCE_ANSWERS[i].id &&
            a.type === REFERENCE_ANSWERS[i].type &&
            a.label === REFERENCE_ANSWERS[i].label &&
            a.answer === REFERENCE_ANSWERS[i].answer
        ),
      JSON.stringify(rest)
    )
  }

  console.log('\n-- a type sent the OLD way (inside answers) is still not stored --')
  // Not a regression — proof the mechanism the brief assumed never existed.
  // validateBookingAnswers reads answersMap[q.id] for DEFINED questions only.
  {
    configuredTypes = ['Discovery Call', 'Strategy Session']
    const b = await makeBooking({ answers: { booking_type: 'Strategy Session', q_challenge: 'a', q_goal: 'b', q_revenue: '$10k+' } })
    ok('the booking still succeeds', b.status === 200, `${b.status}`)
    ok(
      'and the answers-map type is discarded, exactly as it was for 937c0f16',
      (b.row?.custom_answers || []).length === 3,
      JSON.stringify(b.row?.custom_answers)
    )
  }

  console.log('\n-- Gap 1 acceptance 2: an unknown type is refused, not stored silently --')
  {
    configuredTypes = ['Discovery Call', 'Strategy Session']
    const b = await makeBooking({ booking_type: 'Pizza Party' })
    ok('the booking is 400', b.status === 400, `${b.status}`)
    ok('with a readable message naming the options', /Discovery Call/.test(String(b.body?.message)), JSON.stringify(b.body))
    ok('and nothing was written', b.row === null, JSON.stringify(b.row))
  }

  console.log('\n-- Gap 1 acceptance 3: no types configured, no type, still books --')
  {
    configuredTypes = null
    const b = await makeBooking()
    ok('the booking succeeds', b.status === 200, `${b.status}`)
    ok('and stores the three answers only', (b.row?.custom_answers || []).length === 3, JSON.stringify(b.row?.custom_answers))

    const stray = await makeBooking({ booking_type: 'Strategy Session' })
    ok('a stray type with no configuration is ignored, not rejected', stray.status === 200, `${stray.status}`)
    ok('and is not stored', (stray.row?.custom_answers || []).length === 3, JSON.stringify(stray.row?.custom_answers))
  }

  console.log('\n-- absence stays allowed even once types ARE configured --')
  // DELIBERATE. Requiring it the moment an admin saves booking_types would 400
  // every booking made between this deploy and the frontend's, because the page
  // currently sends the type inside `answers`. A booking that loses its type is
  // a missing label; a booking that 400s is a lost lead.
  {
    configuredTypes = ['Discovery Call', 'Strategy Session']
    const b = await makeBooking()
    ok('a booking with no type still succeeds', b.status === 200, `${b.status} ${JSON.stringify(b.body)}`)
    ok('and simply carries no type entry', (b.row?.custom_answers || []).length === 3, JSON.stringify(b.row?.custom_answers))
  }

  console.log('\n-- the stored spelling comes from the admin list, not the client --')
  {
    configuredTypes = ['Discovery Call', 'Strategy Session']
    const r = await resolveBookingType('strategy session')
    ok('a casing mismatch resolves', r.ok === true && r.entry !== null)
    ok('to the CONFIGURED spelling', r.ok === true && r.entry?.answer === 'Strategy Session', JSON.stringify(r.ok && r.entry))
    const padded = await resolveBookingType('  Discovery Call  ')
    ok('and whitespace is trimmed', padded.ok === true && padded.entry?.answer === 'Discovery Call')
    ok('the label constant is the one stored', BOOKING_TYPE_LABEL === 'What kind of call is this?')
  }

  console.log('\n-- Gap 2 acceptance 4: the email reads the visitor’s zone --')
  {
    configuredTypes = null
    const b = await makeBooking({ timezone: 'America/Chicago' })
    ok('the booking succeeds', b.status === 200, `${b.status}`)
    ok('the zone is stored on the row', b.row?.timezone === 'America/Chicago', JSON.stringify(b.row?.timezone))

    const label = bookingTimeLabel(START_ISO, 'America/Chicago')
    ok('6:30 PM, not 11:30 PM', /6:30\s*PM/.test(label), label)
    ok('and the zone name rides alongside it', /America\/Chicago/.test(label), label)
    ok('no bare UTC left in the label', !/UTC/.test(label), label)

    const confirmation = b.emails.find((e) => /booked/i.test(String(e.subject || '')) || /booked/i.test(String(e.html || '')))
    ok('the confirmation email carries the local rendering', !!confirmation && String(confirmation.html).includes('6:30'), String(confirmation?.html || '').slice(0, 200))
    ok('and not the UTC one', !!confirmation && !String(confirmation.html).includes('11:30'), 'still rendering 11:30 PM')
  }

  console.log('\n-- Gap 2 acceptance 5: no zone, or a bad one, still books and still says UTC --')
  {
    configuredTypes = null
    const none = await makeBooking()
    ok('no timezone still books', none.status === 200, `${none.status}`)
    ok('and stores null rather than a guess', none.row?.timezone === null, JSON.stringify(none.row?.timezone))

    const bad = await makeBooking({ timezone: 'Mars/Olympus_Mons' })
    ok('an invalid zone still books', bad.status === 200, `${bad.status}`)
    ok('and is not stored', bad.row?.timezone === null, JSON.stringify(bad.row?.timezone))

    // Byte-identical to the label that shipped before, so nothing regresses.
    const label = bookingTimeLabel(START_ISO, null)
    ok('the fallback is the exact previous wording', label === 'Tuesday, August 18, 2026 at 11:30 PM (UTC)', label)
    ok('a bad zone falls back the same way', bookingTimeLabel(START_ISO, 'Mars/Olympus_Mons') === label)
  }

  console.log('\n-- zone validation --')
  {
    ok('a real zone validates', isValidTimeZone('America/Chicago'))
    ok('UTC validates', isValidTimeZone('UTC'))
    ok('a made-up zone does not', !isValidTimeZone('Mars/Olympus_Mons'))
    // Node's Intl ACCEPTS an offset zone ('-05:00') — ECMA-402 allows them, and
    // it formats correctly. Not rejected, because the result is still an
    // unambiguous instant; it just renders without a zone name. A frontend
    // sending an offset instead of an IANA name degrades to a bare time rather
    // than to UTC, which is a smaller loss than refusing the booking.
    ok('an offset zone is accepted, since Intl resolves it', isValidTimeZone('-05:00'))
    ok(
      'and it renders the right local time',
      /6:30\s*PM/.test(bookingTimeLabel(START_ISO, '-05:00')),
      bookingTimeLabel(START_ISO, '-05:00')
    )
    ok('empty is not a zone', !isValidTimeZone(''))
    ok('a non-string is not a zone', !isValidTimeZone(42))
    ok('normalize trims', normalizeTimeZone('  America/Chicago  ') === 'America/Chicago')
    ok('normalize returns null for junk', normalizeTimeZone('nope') === null)

    // DST is resolved per instant, not assumed — a January call in Chicago is
    // CST, an August one CDT, and the label must not be an hour out either way.
    const jan = bookingTimeLabel('2026-01-18T23:30:00.000Z', 'America/Chicago')
    ok('a January instant renders 5:30 PM (CST)', /5:30\s*PM/.test(jan), jan)
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
