process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = 'zoom-secret'

import crypto from 'crypto'
import { Readable } from 'stream'
import { signManageToken } from '../lib/funnelLeadToken'
import { MANAGE_CUTOFF_MS } from '../lib/bookingManage'

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

const BOOKING = 'bk-1'
const ZOOM_ID = '99887766'
const CLIENT_EMAIL = 'client@example.com'
const COACH = 'coach-1'

type Booking = {
  id: string
  coach_user_id: string | null
  status: string
  email: string
  name: string | null
  start_time: string
  end_time: string
  timezone: string | null
  zoom_meeting_id: string | null
  zoom_join_url: string | null
  google_event_id: string | null
  meeting_url: string | null
  funnel_id: string | null
  reschedule_count: number
  canceled_at: string | null
  canceled_by: string | null
}

let bookings: Booking[] = []
let sends: { kind: string; to: string; from: string; subject: string; html: string; booking_id: string | null }[] = []
let queuedReminders: { booking_id: string; status: string; resend_message_id: string }[] = []
let resendCancels: string[] = []

function makeBooking(startInMs: number): Booking {
  return {
    id: BOOKING,
    coach_user_id: COACH,
    status: 'active',
    email: CLIENT_EMAIL,
    name: 'Dana Mercer',
    start_time: new Date(Date.now() + startInMs).toISOString(),
    end_time: new Date(Date.now() + startInMs + 30 * 60_000).toISOString(),
    timezone: 'America/New_York',
    zoom_meeting_id: ZOOM_ID,
    zoom_join_url: 'https://zoom.us/j/1',
    google_event_id: null,
    meeting_url: null,
    funnel_id: null,
    reschedule_count: 0,
    canceled_at: null,
    canceled_by: null,
  }
}

function reset(startInMs = 48 * 60 * 60_000) {
  bookings = [makeBooking(startInMs)]
  sends = []
  queuedReminders = [{ booking_id: BOOKING, status: 'queued', resend_message_id: 'msg-reminder-1' }]
  resendCancels = []
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(b === null ? 'null' : JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.resend.com/emails/') && method === 'POST') {
    resendCancels.push(url.split('/emails/')[1].replace(/\/cancel.*$/, ''))
    return json({ id: 'canceled' })
  }
  if (url.includes('api.resend.com')) {
    sends.push({
      kind: 'send',
      to: String(body?.to || ''),
      from: String(body?.from || ''),
      subject: String(body?.subject || ''),
      html: String(body?.html || ''),
      booking_id: null,
    })
    return json({ id: `msg-${sends.length}` })
  }

  if (url.includes('/rest/v1/bookings')) {
    if (method === 'PATCH') {
      const zoomId = /zoom_meeting_id=eq\.([^&]+)/.exec(url)?.[1]
      const id = /[?&]id=eq\.([^&]+)/.exec(url)?.[1]
      const wantsActive = /status=eq\.active/.test(url)
      const hit = bookings.filter(
        (b) => (zoomId ? b.zoom_meeting_id === zoomId : true) && (id ? b.id === id : true) && (!wantsActive || b.status === 'active')
      )
      for (const b of hit) Object.assign(b, body)
      return json(hit)
    }
    const id = /[?&]id=eq\.([^&]+)/.exec(url)?.[1]
    const rows = bookings.filter((b) => (id ? b.id === id : true))
    return /vnd\.pgrst\.object/.test(String(init?.headers?.Accept || '')) || id ? json(rows[0] ?? null) : json(rows)
  }

  if (url.includes('/rest/v1/funnel_email_sends')) {
    if (method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body
      sends.push({ kind: String(row.kind), to: '', from: '', subject: '', html: '', booking_id: row.booking_id ?? null })
      return json(row)
    }
    if (method === 'PATCH') return json([])
    const bookingId = /booking_id=eq\.([^&]+)/.exec(url)?.[1]
    return json(queuedReminders.filter((r) => (bookingId ? r.booking_id === bookingId : true) && r.status === 'queued'))
  }

  if (url.includes('/rest/v1/users')) return json({ id: COACH, email: 'coach@example.com', status: 'active', role: 'user' })
  if (url.includes('/rest/v1/funnel_business_settings')) {
    return json({ user_id: COACH, business_name: 'Dana Kirby Coaching', brand_primary_color: '#7C3AED', logo_url: null, theme_mode: 'dark' })
  }
  return json([])
}) as typeof fetch

function zoomReq(payload: unknown) {
  const raw = JSON.stringify(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v0=' + crypto.createHmac('sha256', 'zoom-secret').update(`v0:${ts}:${raw}`).digest('hex')
  const s: any = Readable.from([Buffer.from(raw)])
  s.method = 'POST'
  s.headers = { 'x-zm-signature': sig, 'x-zm-request-timestamp': ts }
  s.query = {}
  return s
}

async function call(handler: Handler, req: any) {
  let status = 0
  let resBody: any = null
  const res: any = {
    setHeader() {},
    status(c: number) { status = c; return res },
    json(v: unknown) { resBody = v; return res },
    end() { return res },
  }
  await handler(req, res)
  return { status, body: resBody }
}

// Written out independently of the handlers.
const emailsTo = (addr: string) => sends.filter((s) => s.to === addr)
const sendRows = (kind: string) => sends.filter((s) => s.kind === kind)

;(async () => {
  const { default: zoomHandler } = await import('../api/zoom/webhook')
  const { default: clientCancel } = await import('../api/funnel/booking/cancel')

  console.log('\n-- the CLIENT path stamps who and when --')
  {
    reset(48 * 60 * 60_000)
    const r = await call(clientCancel, {
      method: 'POST',
      headers: {},
      body: { token: signManageToken(BOOKING) },
      query: {},
    })
    eq('200', r.status, 200)
    const b = bookings[0]
    eq('status canceled', b.status, 'canceled')
    // Asserted as a STORED VALUE, not as "the endpoint returned 200".
    ok('canceled_at was stored', typeof b.canceled_at === 'string' && !Number.isNaN(Date.parse(b.canceled_at!)), String(b.canceled_at))
    eq('canceled_by is client', b.canceled_by, 'client')
  }

  console.log('\n-- and it still refuses inside the cutoff, so its rows are early by construction --')
  {
    reset(1 * 60 * 60_000) // 1h out — inside MANAGE_CUTOFF_MS
    const r = await call(clientCancel, { method: 'POST', headers: {}, body: { token: signManageToken(BOOKING) }, query: {} })
    eq('409 cutoff', r.status, 409)
    eq('and nothing was stamped', [bookings[0].status, bookings[0].canceled_at, bookings[0].canceled_by], ['active', null, null])
    ok('which is why a late CLIENT cancel cannot exist', MANAGE_CUTOFF_MS === 3 * 60 * 60_000, String(MANAGE_CUTOFF_MS))
  }

  console.log('\n-- the ZOOM path stamps coach, and has no cutoff --')
  {
    // 1 hour out: the client path would refuse this. Zoom is the only way a
    // LATE cancellation enters the system, which is what makes canceled_by
    // load-bearing rather than decorative.
    reset(1 * 60 * 60_000)
    const r = await call(zoomHandler, zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } }))
    eq('200 to Zoom', r.status, 200)
    const b = bookings[0]
    eq('status canceled', b.status, 'canceled')
    ok('canceled_at was stored', typeof b.canceled_at === 'string', String(b.canceled_at))
    eq('canceled_by is coach', b.canceled_by, 'coach')
  }

  console.log('\n-- BOTH halves fire: reminders stop AND the client is told --')
  {
    reset()
    await call(zoomHandler, zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } }))

    // Shipping the email without stopping the reminders would tell the client
    // it is cancelled and then remind them about it twice. Both are asserted,
    // because either alone is a worse outcome than the pair.
    eq('the queued reminder was cancelled at Resend', resendCancels, ['msg-reminder-1'])
    const toClient = emailsTo(CLIENT_EMAIL)
    eq('exactly one email to the client', toClient.length, 1)
    // Read through a fallback rather than indexing directly: the mutation this
    // section exists to catch — stopping the reminders but never telling the
    // client — produces ZERO emails, and toClient[0].subject would kill the
    // process before the remaining assertions ran. A half-shipped cancellation
    // should name the half that is missing, not throw a stack trace.
    ok('and it says cancelled', /cancelled/i.test(toClient[0]?.subject ?? ''), JSON.stringify(toClient[0]?.subject))
    eq('the send was logged against the booking', sendRows('booking_canceled').length, 1)
  }

  console.log('\n-- the email is the COACH brand, not MTM --')
  {
    reset()
    await call(zoomHandler, zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } }))
    const mail = emailsTo(CLIENT_EMAIL)[0] ?? { from: '', html: '', subject: '' }

    // By VALUE against the coach's business name, and by the ABSENCE of the MTM
    // wordmark in the from-name — a client's relationship is with the coach,
    // and a cancellation from a platform they have never heard of is worse than
    // the cancellation.
    ok('from-name is the coach', mail.from.startsWith('Dana Kirby Coaching'), mail.from)
    ok('not MTM', !/^Micro-Training Method/.test(mail.from), mail.from)
    ok('the body carries the coach business name', mail.html.includes('Dana Kirby Coaching'), 'coach branding missing')

    // The time is rendered in the zone the visitor booked in, not UTC.
    ok('the cancelled time is shown', /line-through/.test(mail.html))
  }

  console.log('\n-- Zoom redelivers, and a redelivery must not re-send --')
  {
    reset()
    const evt = zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } })
    await call(zoomHandler, evt)
    const afterFirst = { cancels: resendCancels.length, mails: emailsTo(CLIENT_EMAIL).length }

    await call(zoomHandler, zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } }))
    eq('no second reminder cancel', resendCancels.length, afterFirst.cancels)
    eq('no second email to the client', emailsTo(CLIENT_EMAIL).length, afterFirst.mails)
    eq('and the stamps were not rewritten', bookings[0].canceled_by, 'coach')
  }

  console.log('\n-- an unsigned Zoom event changes nothing --')
  {
    reset()
    const raw = JSON.stringify({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } })
    const s: any = Readable.from([Buffer.from(raw)])
    s.method = 'POST'
    s.headers = { 'x-zm-signature': 'v0=deadbeef', 'x-zm-request-timestamp': String(Math.floor(Date.now() / 1000)) }
    s.query = {}
    const r = await call(zoomHandler, s)
    eq('401', r.status, 401)
    eq('booking untouched', [bookings[0].status, bookings[0].canceled_by], ['active', null])
    eq('no email', emailsTo(CLIENT_EMAIL).length, 0)
    eq('no reminder cancel', resendCancels.length, 0)
  }

  console.log('\n-- the two paths write DIFFERENT provenance for the same booking --')
  {
    // The whole point of canceled_by. If both wrote the same value the column
    // would be decorative, and a client would be charged for a call their coach
    // cancelled.
    reset(48 * 60 * 60_000)
    await call(clientCancel, { method: 'POST', headers: {}, body: { token: signManageToken(BOOKING) }, query: {} })
    const byClient = bookings[0].canceled_by

    reset(48 * 60 * 60_000)
    await call(zoomHandler, zoomReq({ event: 'meeting.deleted', payload: { object: { id: ZOOM_ID } } }))
    const byCoach = bookings[0].canceled_by

    eq('client path', byClient, 'client')
    eq('zoom path', byCoach, 'coach')
    ok('and they are not the same value', byClient !== byCoach)
  }

  console.log('\n-- the migration is on disk and numbered next --')
  {
    const { readdirSync, readFileSync } = await import('fs')
    const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    const mine = files.filter((f) => f.startsWith('094_'))
    eq('exactly one 094', mine.length, 1)
    const sql = readFileSync(`supabase/migrations/${mine[0]}`, 'utf8')
    ok('adds canceled_at', /add column if not exists canceled_at/.test(sql))
    ok('adds canceled_by', /add column if not exists canceled_by/.test(sql))
    ok('constrains canceled_by to the three values', /'client', 'coach', 'system'/.test(sql))

    // It must NOT reference client_programs: that table does not exist until the
    // next migration, so a foreign key to it here would make this migration
    // unappliable on its own — the one thing a change designed to ship
    // independently must not be.
    ok('and does NOT reference client_programs', !/client_programs/.test(sql.replace(/--[^\n]*/g, '')), 'an FK to a table that does not exist yet')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  if (fail) process.exit(1)
})()
