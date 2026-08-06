process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.MANAGE_TOKEN_SECRET = 'stub-manage'
process.env.ZOOM_ACCOUNT_ID = 'a'
process.env.ZOOM_CLIENT_ID = 'b'
process.env.ZOOM_CLIENT_SECRET = 'c'
process.env.ZOOM_SCHEDULE_ID = 'sched'

// NOT static imports. lib/email.ts runs `new Resend(process.env.RESEND_API_KEY!)`
// at module scope and ES imports hoist above the assignments above, so a static
// import here constructs the client before the stub key exists. Documented in
// CLAUDE.md; every test touching the mail path does this.
type ScheduleFn = (ctx: any) => Promise<void>
let MTM_BRAND: any
let scheduleBookingReminders: ScheduleFn

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

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-09-01T12:00:00.000Z')

// Every row that reached funnel_email_sends, and every message handed to Resend.
let sendRows: any[] = []
let resendCalls: any[] = []
let unsubscribed = new Set<string>()

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/funnel_leads')) {
    const m = /id=eq\.([^&]+)/.exec(url)
    const id = m ? decodeURIComponent(m[1]) : ''
    return json({ email_unsubscribed: unsubscribed.has(id) })
  }
  if (url.includes('/rest/v1/funnel_email_sends')) {
    if (method === 'POST') {
      for (const row of Array.isArray(body) ? body : [body]) sendRows.push(row)
      return json(Array.isArray(body) ? body : [body])
    }
    return json([])
  }
  if (url.includes('resend.com')) {
    resendCalls.push(body)
    return json({ id: `msg-${resendCalls.length}` })
  }
  return json({})
}) as typeof fetch

const base = (over: Record<string, unknown> = {}) => ({
  brand: MTM_BRAND,
  funnelId: null,
  leadId: null,
  email: 'visitor@example.com',
  joinUrl: 'https://zoom.us/j/1',
  bookingId: 'booking-1',
  manageUrl: 'https://api.example.com/api/funnel/booking?token=t',
  timezone: 'America/Chicago',
  nowMs: NOW,
  ...over,
})

async function schedule(startOffsetMs: number, over: Record<string, unknown> = {}) {
  sendRows = []
  resendCalls = []
  await scheduleBookingReminders({ ...base(over), startIso: new Date(NOW + startOffsetMs).toISOString() } as any)
  // Sorted by scheduled_at, not by arrival: the sends run concurrently under
  // Promise.all, so insertion order is completion order and asserting on it
  // would be asserting on a race. Chronological IS cadence order.
  const kinds = sendRows
    .slice()
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
    .map((r) => r.kind)
  return { rows: sendRows, calls: resendCalls, kinds }
}

;(async () => {
  MTM_BRAND = (await import('../lib/email')).MTM_BRAND
  scheduleBookingReminders = (await import('../lib/funnelNurture')).scheduleBookingReminders

  console.log('\n-- acceptance 1: a booking 10 days out gets all four reminders --')
  {
    const r = await schedule(10 * DAY)
    ok('four reminder rows', r.rows.length === 4, JSON.stringify(r.kinds))
    ok(
      'one of each kind, in cadence order',
      JSON.stringify(r.kinds) === JSON.stringify(['reminder_1w', 'reminder_3d', 'reminder_24h', 'reminder_1h']),
      JSON.stringify(r.kinds)
    )
    ok('every row carries the booking_id', r.rows.every((x) => x.booking_id === 'booking-1'), JSON.stringify(r.rows.map((x) => x.booking_id)))
    ok('and a NULL funnel_id, which migration 089 allows', r.rows.every((x) => x.funnel_id === null), JSON.stringify(r.rows.map((x) => x.funnel_id)))
    ok('all queued, so cancelBookingReminders can find them', r.rows.every((x) => x.status === 'queued'), JSON.stringify(r.rows.map((x) => x.status)))
    ok('each carries the Resend message id it can be canceled by', r.rows.every((x) => typeof x.resend_message_id === 'string' && x.resend_message_id), JSON.stringify(r.rows.map((x) => x.resend_message_id)))

    // The scheduled instants, checked against the call rather than each other.
    const startMs = NOW + 10 * DAY
    const at = (k: string) => Date.parse(r.rows.find((x) => x.kind === k)!.scheduled_at)
    ok('1w lands 7 days before the call', startMs - at('reminder_1w') === 7 * DAY)
    ok('3d lands 3 days before', startMs - at('reminder_3d') === 3 * DAY)
    ok('24h lands 24 hours before', startMs - at('reminder_24h') === 24 * HOUR)
    ok('1h lands 1 hour before', startMs - at('reminder_1h') === 1 * HOUR)
    ok('every one is in the future', r.rows.every((x) => Date.parse(x.scheduled_at) > NOW))
  }

  console.log('\n-- acceptance 2: two days out, no 1-week or 3-day row EXISTS --')
  // Not a row dated in the past — no row at all. A past scheduledAt is either
  // rejected by Resend or fires immediately, and "your call is next week" for a
  // call in two days is the version of this that embarrasses you.
  {
    const r = await schedule(2 * DAY)
    ok('exactly two rows', r.rows.length === 2, JSON.stringify(r.kinds))
    ok('24h and 1h only', JSON.stringify(r.kinds) === JSON.stringify(['reminder_24h', 'reminder_1h']), JSON.stringify(r.kinds))
    ok('no reminder_1w row', !r.kinds.includes('reminder_1w'))
    ok('no reminder_3d row', !r.kinds.includes('reminder_3d'))
    ok('and nothing was handed to Resend for them either', r.calls.length === 2, String(r.calls.length))
  }

  console.log('\n-- the boundary: 6 days out --')
  // 6 days is the case that distinguishes "skip what is past" from "clamp to
  // now". The 1w offset is 1 day in the past; the 3d offset is 3 days ahead.
  {
    const r = await schedule(6 * DAY)
    ok('three rows', r.rows.length === 3, JSON.stringify(r.kinds))
    ok('1w is dropped, 3d survives', JSON.stringify(r.kinds) === JSON.stringify(['reminder_3d', 'reminder_24h', 'reminder_1h']), JSON.stringify(r.kinds))
  }

  console.log('\n-- acceptance 3: 30 minutes out schedules nothing --')
  {
    const r = await schedule(30 * 60 * 1000)
    ok('no reminder rows at all', r.rows.length === 0, JSON.stringify(r.kinds))
    ok('and nothing reached Resend', r.calls.length === 0, String(r.calls.length))
    // The confirmation is sent by the booking handler, not here, so it is
    // unaffected — this function returning empty IS the correct outcome.
  }

  console.log('\n-- exactly on a boundary --')
  {
    // A call exactly 1 hour out: the 1h reminder would land now, inside the
    // 60-second margin, so it is dropped rather than sent as an "immediate"
    // scheduled message.
    const r = await schedule(1 * HOUR)
    ok('a call exactly 1 hour out schedules nothing', r.rows.length === 0, JSON.stringify(r.kinds))

    const r2 = await schedule(1 * HOUR + 5 * 60 * 1000)
    ok('five minutes more and the 1h reminder is scheduled', JSON.stringify(r2.kinds) === JSON.stringify(['reminder_1h']), JSON.stringify(r2.kinds))
  }

  console.log('\n-- acceptance 6: a funnel booking gets the same five, and keeps its ids --')
  {
    const r = await schedule(10 * DAY, { funnelId: 'funnel-1', leadId: 'lead-1' })
    ok('the same four reminders', r.rows.length === 4, JSON.stringify(r.kinds))
    ok('funnel_id is carried', r.rows.every((x) => x.funnel_id === 'funnel-1'), JSON.stringify(r.rows.map((x) => x.funnel_id)))
    ok('lead_id is carried', r.rows.every((x) => x.lead_id === 'lead-1'), JSON.stringify(r.rows.map((x) => x.lead_id)))
  }

  console.log('\n-- unsubscribe, decided rather than fallen into --')
  {
    unsubscribed = new Set(['lead-gone'])
    const off = await schedule(10 * DAY, { funnelId: 'funnel-1', leadId: 'lead-gone' })
    ok('an unsubscribed LEAD gets no reminders', off.rows.length === 0, JSON.stringify(off.kinds))

    // A public booking has no lead, so there is nobody to ask and nothing to
    // check against. The booking is the consent.
    const pub = await schedule(10 * DAY, { leadId: null, funnelId: null })
    ok('a public booking with no lead is unaffected by that', pub.rows.length === 4, JSON.stringify(pub.kinds))
    unsubscribed = new Set()
  }

  console.log('\n-- acceptance 7: every reminder renders the visitor’s timezone --')
  // The defect that started this thread, and it lands the day before — which is
  // when a no-show gets decided.
  {
    // 2026-09-11 23:30Z is 6:30 PM America/Chicago.
    sendRows = []
    resendCalls = []
    await scheduleBookingReminders({ ...base(), startIso: '2026-09-11T23:30:00.000Z' } as any)
    ok('four emails composed', resendCalls.length === 4, String(resendCalls.length))
    ok(
      'each says 6:30 PM America/Chicago',
      resendCalls.every((c) => String(c.html).includes('6:30') && String(c.html).includes('America/Chicago')),
      String(resendCalls[0]?.html || '').slice(0, 240)
    )
    ok('and none says 11:30 PM', resendCalls.every((c) => !String(c.html).includes('11:30')))
    ok('the manage link rides on every one', resendCalls.every((c) => String(c.html).includes('reschedule or cancel')))

    // No timezone captured falls back to the same UTC wording as before.
    sendRows = []
    resendCalls = []
    await scheduleBookingReminders({ ...base({ timezone: null }), startIso: '2026-09-11T23:30:00.000Z' } as any)
    ok('with no zone captured it still renders, in UTC', resendCalls.every((c) => String(c.html).includes('11:30 PM (UTC)')), String(resendCalls[0]?.html || '').slice(0, 240))
  }

  console.log('\n-- the public brand is MTM, never an unbranded email --')
  {
    const r = await schedule(10 * DAY)
    ok('from name is Micro-Training Method', r.calls.every((c) => String(c.from).startsWith('Micro-Training Method')), String(r.calls[0]?.from))
    ok('no reply-to pointing at a coach', r.calls.every((c) => !c.replyTo), JSON.stringify(r.calls[0]?.replyTo))
    ok('the body carries the business name', String(r.calls[0]?.html).includes('Micro-Training Method'))
  }

  console.log('\n-- a missing email is a no-op, not a throw --')
  {
    const r = await schedule(10 * DAY, { email: '' })
    ok('nothing scheduled', r.rows.length === 0)
    const bad = await schedule(10 * DAY, {})
    sendRows = []
    resendCalls = []
    await scheduleBookingReminders({ ...base(), startIso: 'not-a-date' } as any)
    ok('an unparseable start is a no-op too', sendRows.length === 0)
    void bad
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
