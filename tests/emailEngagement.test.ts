process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('unit-test-secret').toString('base64')

// Dynamic imports below: the webhook handler pulls in lib/funnelNurture ->
// lib/email, which constructs `new Resend(process.env.RESEND_API_KEY!)` at
// module scope. A static import would have esbuild run that before the env
// assignments above.
import { projectSelect } from './support/postgrest'
import crypto from 'crypto'
import { Readable } from 'stream'
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0
let fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const FUNNEL_ID = 'f-1'
const USER_ID = 'u-1'

type Row = {
  kind: string; status: string; scheduled_at: string | null; sent_at: string | null
  delivered_at: string | null; bounced_at: string | null; complained_at: string | null
  opened_at: string | null; clicked_at: string | null; open_count: number; click_count: number
  resend_message_id: string | null
}
let sends: Row[] = []
let events: { event_type: string; metadata: Record<string, unknown> }[] = []
let rpcAvailable = true
let eventInserts: any[] = []

function mkRow(kind: string, msgId: string, o: Partial<Row> = {}): Row {
  return {
    kind, status: 'sent', scheduled_at: null, sent_at: null, delivered_at: null,
    bounced_at: null, complained_at: null, opened_at: null, clicked_at: null,
    open_count: 0, click_count: 0, resend_message_id: msgId, ...o,
  }
}

// Faithful stand-in for migration 074's record_email_engagement(): coalesce for
// first touch, unconditional increment for the counter.
function rpcRecordEngagement(messageId: string, event: string, at: string) {
  const row = sends.find((r) => r.resend_message_id === messageId)
  if (!row) return []
  if (event === 'opened') { row.opened_at = row.opened_at ?? at; row.open_count += 1 }
  else { row.clicked_at = row.clicked_at ?? at; row.click_count += 1 }
  return [{ funnel_id: FUNNEL_ID, lead_id: 'lead-1', kind: row.kind }]
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/rpc/record_email_engagement')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (!rpcAvailable) return json({ code: 'PGRST202', message: 'function does not exist' }, 404)
    return json(rpcRecordEngagement(body.p_message_id, body.p_event, body.p_at))
  }
  if (url.includes('/rest/v1/users')) return json({ status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} })
  if (url.includes('/rest/v1/funnels')) return json({ id: FUNNEL_ID, user_id: USER_ID })
  if (url.includes('/rest/v1/funnel_email_sends')) {
    const m = /resend_message_id=eq\.([^&]+)/.exec(url)
    if (m) {
      const row = sends.find((r) => r.resend_message_id === decodeURIComponent(m[1]))
      return json(row ? { funnel_id: FUNNEL_ID, lead_id: 'lead-1', kind: row.kind } : null)
    }
    return json(sends)
  }
  if (url.includes('/rest/v1/funnel_events')) {
    if (method === 'POST') { eventInserts.push(init?.body ? JSON.parse(String(init.body)) : {}); return json({}) }
    return json(events)
  }
  if (url.includes('/rest/v1/funnel_leads')) return json({})
  return json([])
}) as typeof fetch

function svixHeaders(raw: string) {
  const id = 'msg_test'
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET!.replace(/^whsec_/, ''), 'base64')
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }
}

async function postWebhook(handler: Handler, type: string, messageId: string, extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ type, data: { email_id: messageId, ...extra } })
  // Buffer, not string — the handler does Buffer.concat(chunks).
  const req: any = Readable.from([Buffer.from(raw, 'utf8')])
  req.headers = svixHeaders(raw)
  req.method = 'POST'
  let status = 0
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json() { return res }, end() { return res } }
  await handler(req, res)
  return status
}

async function getEmails(handler: Handler): Promise<any> {
  const token = await createSessionToken(USER_ID)
  let body: any = null
  const res: any = { setHeader() {}, status() { return res }, json(v: unknown) { body = v; return res }, end() { return res } }
  await handler({ query: { id: FUNNEL_ID }, headers: { authorization: `Bearer ${token}` }, method: 'GET' } as any, res)
  return body
}

const STAMP = '2026-08-01T00:00:00Z'

;(async () => {
  const webhook: Handler = (await import('../api/webhooks/resend')).default
  const emails: Handler = (await import('../api/funnels/[id]/emails')).default

  console.log('\n-- webhook: first open stamps opened_at and bumps open_count --')
  sends = [mkRow('nurture_1', 'm-1', { delivered_at: STAMP })]
  eventInserts = []
  ok('200', (await postWebhook(webhook, 'email.opened', 'm-1')) === 200)
  ok('opened_at set', !!sends[0].opened_at)
  ok('open_count = 1', sends[0].open_count === 1)
  ok('funnel_events row still written (activity feed unchanged)', eventInserts.length === 1 && eventInserts[0].event_type === 'email_opened')

  console.log('\n-- webhook: repeat opens never move the first-touch timestamp --')
  const firstTouch = sends[0].opened_at
  await new Promise((r) => setTimeout(r, 5))
  await postWebhook(webhook, 'email.opened', 'm-1')
  await postWebhook(webhook, 'email.opened', 'm-1')
  ok('opened_at unchanged after 2 more opens', sends[0].opened_at === firstTouch, `${firstTouch} -> ${sends[0].opened_at}`)
  ok('open_count bumped to 3', sends[0].open_count === 3, `got ${sends[0].open_count}`)

  console.log('\n-- webhook: clicks tracked separately --')
  ok('200', (await postWebhook(webhook, 'email.clicked', 'm-1', { click: { link: 'https://example.com/book' } })) === 200)
  ok('clicked_at set, click_count = 1', !!sends[0].clicked_at && sends[0].click_count === 1)
  ok('opened_at untouched by a click', sends[0].opened_at === firstTouch)
  ok('click event carries the url', eventInserts.some((e) => e.metadata?.url === 'https://example.com/book'))
  await postWebhook(webhook, 'email.clicked', 'm-1', { click: { link: 'https://example.com/other' } })
  ok('second click bumps the count only', sends[0].click_count === 2)

  console.log('\n-- webhook: unknown message id is a no-op --')
  eventInserts = []
  ok('200', (await postWebhook(webhook, 'email.opened', 'nope')) === 200)
  ok('no funnel_events row', eventInserts.length === 0)

  console.log('\n-- webhook: RPC missing (deployed before migration 074) degrades, never drops the event --')
  rpcAvailable = false
  sends = [mkRow('nurture_1', 'm-2')]
  eventInserts = []
  ok('200', (await postWebhook(webhook, 'email.opened', 'm-2')) === 200)
  ok('falls back to lookup and still writes funnel_events', eventInserts.length === 1)
  rpcAvailable = true

  console.log('\n-- LIVE BUG 1: 8 opens over 1 delivered used to report 800% --')
  sends = [
    mkRow('nurture_1', 'n1-0', { sent_at: STAMP, delivered_at: STAMP }),
    ...Array.from({ length: 7 }, (_, i) => mkRow('nurture_1', `n1-${i + 1}`)),
  ]
  events = Array.from({ length: 8 }, (_, i) => ({ event_type: 'email_opened', metadata: { kind: 'nurture_1', resend_message_id: `n1-${i}` } }))
  const r1 = await getEmails(emails)
  const n1 = r1?.emails?.find((e: any) => e.kind === 'nurture_1')
  ok('open_pct <= 100, not 800', n1?.open_pct !== null && n1.open_pct <= 100, `got ${n1?.open_pct}`)
  ok('basis is delivered', n1?.rate_basis === 'delivered')
  ok('totals.open_pct bounded', r1?.totals?.open_pct <= 100, `got ${r1?.totals?.open_pct}`)
  ok('health.open_rate bounded', r1?.health?.open_rate <= 100, `got ${r1?.health?.open_rate}`)
  ok('raw opens still reported', n1?.total_opens === 8, `got ${n1?.total_opens}`)

  console.log('\n-- DECISION: un-provable legacy rows show "—", never a fabricated ~100% --')
  // Queued rows carrying opens: the delivery webhook never landed for them.
  sends = Array.from({ length: 6 }, (_, i) => mkRow('nurture_3', `n3-${i}`, { status: 'queued', scheduled_at: '2026-08-04T00:00:00Z' }))
  events = Array.from({ length: 3 }, (_, i) => ({ event_type: 'email_opened', metadata: { kind: 'nurture_3', resend_message_id: `n3-${i}` } }))
  const r2 = await getEmails(emails)
  const n3 = r2?.emails?.find((e: any) => e.kind === 'nurture_3')
  ok('open_pct is null ("—"), not ~100', n3?.open_pct === null, `got ${n3?.open_pct}`)
  ok('click_pct is null too', n3?.click_pct === null)
  ok('rate_basis is null — nothing provable to divide by', n3?.rate_basis === null, `got ${JSON.stringify(n3?.rate_basis)}`)
  ok('an open does NOT back-fill dispatch: all 6 stay queued', n3?.queued === 6 && n3?.sent === 0, `sent=${n3?.sent} queued=${n3?.queued}`)

  // The booking_confirmation shape: status 'sent' written by our own code at
  // hand-off, but no webhook stamp — still not provable dispatch.
  sends = Array.from({ length: 4 }, (_, i) => mkRow('booking_confirmation', `bc-${i}`, { status: 'sent' }))
  events = Array.from({ length: 4 }, (_, i) => ({ event_type: 'email_opened', metadata: { kind: 'booking_confirmation', resend_message_id: `bc-${i}` } }))
  const r3 = await getEmails(emails)
  const bc = r3?.emails?.find((e: any) => e.kind === 'booking_confirmation')
  ok('status=sent without a stamp is NOT a rate denominator -> "—"', bc?.open_pct === null, `got ${bc?.open_pct}`)
  ok('4 opens over 4 self-marked sends does not print 100%', bc?.open_pct !== 100)
  ok('they still count as sent for the delivery column', bc?.sent === 4)
  ok('totals.open_pct also "—"', r3?.totals?.open_pct === null, `got ${r3?.totals?.open_pct}`)
  ok('health.open_rate contributes 0 rather than a fabricated number', r3?.health?.open_rate === 0)

  console.log('\n-- going forward: a properly stamped send computes normally --')
  sends = [
    mkRow('nurture_2', 'n2-0', { sent_at: STAMP, delivered_at: STAMP, opened_at: 'y', open_count: 2 }),
    mkRow('nurture_2', 'n2-1', { sent_at: STAMP, delivered_at: STAMP }),
    mkRow('nurture_2', 'n2-2', { sent_at: STAMP, delivered_at: STAMP, opened_at: 'y', clicked_at: 'z', open_count: 1, click_count: 4 }),
  ]
  events = []
  const r4 = await getEmails(emails)
  const n2 = r4?.emails?.find((e: any) => e.kind === 'nurture_2')
  ok('2 of 3 delivered opened -> 66.7%', n2?.open_pct === 66.7, `got ${n2?.open_pct}`)
  ok('1 of 3 clicked -> 33.3%', n2?.click_pct === 33.3, `got ${n2?.click_pct}`)
  ok('opened counts sends, not events', n2?.opened === 2 && n2?.clicked === 1)
  ok('raw counters summed', n2?.total_opens === 3 && n2?.total_clicks === 4)

  console.log('\n-- sent_at but no delivered_at is still provable dispatch --')
  sends = [
    mkRow('nurture_1', 's-0', { sent_at: STAMP, opened_at: 'y', open_count: 1 }),
    mkRow('nurture_1', 's-1', { sent_at: STAMP }),
  ]
  events = []
  const r5 = await getEmails(emails)
  const s = r5?.emails?.find((e: any) => e.kind === 'nurture_1')
  ok('basis falls back to sent-stamped', s?.rate_basis === 'sent')
  ok('1 of 2 -> 50%', s?.open_pct === 50, `got ${s?.open_pct}`)

  console.log('\n-- a send straddling the migration is not double-counted --')
  sends = [mkRow('nurture_1', 'dup-1', { sent_at: STAMP, delivered_at: STAMP, opened_at: 'y', open_count: 1 })]
  events = [{ event_type: 'email_opened', metadata: { kind: 'nurture_1', resend_message_id: 'dup-1' } }]
  const r6 = await getEmails(emails)
  const dup = r6?.emails?.find((e: any) => e.kind === 'nurture_1')
  ok('counted once', dup?.opened === 1 && dup?.total_opens === 1, `opened=${dup?.opened} total_opens=${dup?.total_opens}`)
  ok('open_pct = 100, not 200', dup?.open_pct === 100)

  console.log('\n-- nothing sent yet: rates null, not 0 --')
  sends = []; events = []
  const r7 = await getEmails(emails)
  ok('per-email open_pct null', r7?.emails?.[0]?.open_pct === null)
  ok('totals open_pct null', r7?.totals?.open_pct === null)
  ok('health score 0, not NaN', r7?.health?.score === 0)

  console.log('\n-- coach notification still excluded from the funnel\'s rates --')
  sends = [
    mkRow('coach_booking_notification', 'coach-1', { sent_at: STAMP, delivered_at: STAMP, opened_at: 'y', open_count: 1 }),
    mkRow('nurture_1', 'lead-x', { sent_at: STAMP, delivered_at: STAMP }),
  ]
  events = []
  const r8 = await getEmails(emails)
  ok('absent from the rows', !r8?.emails?.some((e: any) => e.kind === 'coach_booking_notification'))
  ok('its guaranteed open does not inflate totals', r8?.totals?.opened === 0 && r8?.totals?.open_pct === 0)

  console.log('\n-- delivered/bounced/complained accounting unchanged --')
  sends = [
    mkRow('nurture_1', 'a', { sent_at: STAMP, delivered_at: STAMP }),
    mkRow('nurture_1', 'b', { status: 'failed', bounced_at: STAMP }),
    mkRow('nurture_1', 'c', { sent_at: STAMP, delivered_at: STAMP, complained_at: STAMP }),
    mkRow('nurture_1', 'd', { status: 'canceled' }),
  ]
  events = []
  const r9 = await getEmails(emails)
  const t9 = r9?.emails?.find((e: any) => e.kind === 'nurture_1')
  ok('sent = 3 (canceled excluded)', t9?.sent === 3, `got ${t9?.sent}`)
  ok('delivered = 2', t9?.delivered === 2)
  ok('bounced = 1', t9?.bounced === 1)
  ok('complained = 1, still counted delivered', t9?.complained === 1 && t9?.delivered === 2)
  ok('canceled = 1', t9?.canceled === 1)
  ok('spam_rate uses delivered as denominator', r9?.health?.spam_rate === 50, `got ${r9?.health?.spam_rate}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
