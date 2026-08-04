process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('unit-test-secret').toString('base64')

// Dynamic import below: the webhook handler pulls in lib/email.ts, which
// constructs `new Resend(process.env.RESEND_API_KEY!)` at module scope. A
// static import would let esbuild run that before the env assignments above.
import crypto from 'crypto'
import { Readable } from 'stream'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const MEMBER = 'member-1'
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

type Ticket = {
  id: string; user_id: string; stage: string
  first_response_at: string | null; resolved_at: string | null
  subject: string; created_at: string; updated_at: string
}

let users: Record<string, { email: string; name: string }> = {}
let tickets: Record<string, Ticket> = {}
let messages: any[] = []
let receivingEmails: Record<string, { from: string; text?: string | null; html?: string | null }> = {}
let receivingApiCalls = 0

function mkTicket(id: string, o: Partial<Ticket> = {}): Ticket {
  return {
    id, user_id: MEMBER, stage: 'new', first_response_at: iso(NOW - 2 * 3600_000), resolved_at: null,
    subject: 'Something is broken', created_at: iso(NOW - 3600_000), updated_at: iso(NOW - 3600_000), ...o,
  }
}

function reset() {
  users = { [MEMBER]: { email: 'jamie@example.com', name: 'Jamie Coach' } }
  tickets = {}
  messages = []
  receivingEmails = {}
  receivingApiCalls = 0
}

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/emails/receiving/')) {
    receivingApiCalls++
    const id = url.split('/emails/receiving/')[1].split('?')[0]
    const rec = receivingEmails[id]
    if (!rec) return json({ message: 'not found', statusCode: 404, name: 'not_found' }, 404)
    return json({
      object: 'email', id, to: ['support+x@mail.microtrainingmethod.com'], from: rec.from,
      created_at: iso(NOW), subject: 'Re: ticket', bcc: null, cc: null, reply_to: null,
      received_for: ['support+x@mail.microtrainingmethod.com'], html: rec.html ?? null, text: rec.text ?? null,
      headers: null, message_id: `msg-${id}`, attachments: [],
    })
  }

  if (url.includes('/rest/v1/users')) {
    const id = eqParam(url, 'id')
    return json(id && users[id] ? { id, ...users[id] } : null)
  }

  if (url.includes('/rest/v1/support_tickets')) {
    const id = eqParam(url, 'id')
    if (method === 'PATCH' && id) {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (tickets[id]) Object.assign(tickets[id], body)
      return json(tickets[id] ?? null)
    }
    if (id) return json(tickets[id] ?? null)
    return json(Object.values(tickets))
  }

  if (url.includes('/rest/v1/support_ticket_messages')) {
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (body.resend_email_id && messages.some((m) => m.resend_email_id === body.resend_email_id)) {
        // Real behavior: the partial unique index on resend_email_id 23505s a
        // redelivered inbound email rather than accepting a second insert.
        return json({ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }, 409)
      }
      const row = { id: `msg-row-${messages.length + 1}`, created_at: iso(NOW), ...body }
      messages.push(row)
      return json(row, 201)
    }
    const resendEmailId = eqParam(url, 'resend_email_id')
    if (resendEmailId) return json(messages.find((m) => m.resend_email_id === resendEmailId) ?? null)
    return json(messages)
  }

  return json([])
}) as typeof fetch

function svixHeaders(raw: string, secret = process.env.RESEND_WEBHOOK_SECRET!) {
  const id = 'msg_test'
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }
}

async function postWebhook(handler: Handler, payload: unknown, opts: { badSignature?: boolean } = {}): Promise<number> {
  const raw = JSON.stringify(payload)
  const req: any = Readable.from([Buffer.from(raw, 'utf8')])
  req.headers = svixHeaders(raw, opts.badSignature ? 'whsec_' + Buffer.from('wrong-secret').toString('base64') : undefined)
  req.method = 'POST'
  let status = 0
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json() { return res }, end() { return res } }
  await handler(req, res)
  return status
}

function receivedEvent(emailId: string, toTicketId: string, from: string) {
  const to = `support+${toTicketId}@mail.microtrainingmethod.com`
  return {
    type: 'email.received',
    created_at: iso(NOW),
    data: { email_id: emailId, created_at: iso(NOW), from, to: [to], bcc: [], cc: [], received_for: [to], message_id: `m-${emailId}`, subject: 'Re: Support', attachments: [] },
  }
}

;(async () => {
  const webhook: Handler = (await import('../api/webhooks/resend')).default

  const T_WAITING = 'a1111111-1111-4111-8111-111111111111'
  const T_RESOLVED = 'a2222222-2222-4222-8222-222222222222'
  const T_SPOOF = 'a3333333-3333-4333-8333-333333333333'
  const T_QUOTED = 'a4444444-4444-4444-8444-444444444444'
  const T_UNCHANGED = 'a5555555-5555-4555-8555-555555555555'

  console.log('\n-- valid reply threads in and flips waiting_on_member -> in_progress --')
  reset()
  tickets[T_WAITING] = mkTicket(T_WAITING, { stage: 'waiting_on_member' })
  const originalFirstResponse = tickets[T_WAITING].first_response_at
  receivingEmails['em-1'] = { from: 'Jamie Coach <jamie@example.com>', text: "Thanks, that fixed it!" }
  const s1 = await postWebhook(webhook, receivedEvent('em-1', T_WAITING, 'Jamie Coach <jamie@example.com>'))
  ok('200 ack', s1 === 200)
  ok('message appended, authored by the member', messages.length === 1 && messages[0].ticket_id === T_WAITING && messages[0].author_role === 'member' && messages[0].author_user_id === MEMBER)
  ok('body is what the member typed', messages[0].body === 'Thanks, that fixed it!')
  ok('stage flips to in_progress', tickets[T_WAITING].stage === 'in_progress')
  ok('first_response_at is NOT restamped (already set)', tickets[T_WAITING].first_response_at === originalFirstResponse)
  ok('the flip is silent — no outbound email', !messages.some((m) => m.author_role === 'admin'))

  console.log('\n-- reply to a resolved ticket reopens it and clears resolved_at --')
  reset()
  tickets[T_RESOLVED] = mkTicket(T_RESOLVED, { stage: 'resolved', resolved_at: iso(NOW - 3600_000) })
  receivingEmails['em-2'] = { from: 'jamie@example.com', text: 'One more thing —' }
  const s2 = await postWebhook(webhook, receivedEvent('em-2', T_RESOLVED, 'jamie@example.com'))
  ok('200 ack', s2 === 200)
  ok('reopened to in_progress', tickets[T_RESOLVED].stage === 'in_progress')
  ok('resolved_at cleared, not left stale', tickets[T_RESOLVED].resolved_at === null)

  console.log('\n-- spoofed sender: real ticket id, wrong sender — dropped, not appended --')
  reset()
  tickets[T_SPOOF] = mkTicket(T_SPOOF, { stage: 'new' })
  const s3 = await postWebhook(webhook, receivedEvent('em-3', T_SPOOF, 'attacker@evil.com'))
  ok('200 ack (webhooks always 2xx so Resend does not retry-storm)', s3 === 200)
  ok('nothing appended', messages.length === 0)
  ok('ticket stage untouched', tickets[T_SPOOF].stage === 'new')
  ok('never spent the follow-up receiving.get call on a request that will be dropped', receivingApiCalls === 0)

  console.log('\n-- heavy quoted content is stored stripped, not verbatim --')
  reset()
  tickets[T_QUOTED] = mkTicket(T_QUOTED, { stage: 'in_progress' })
  receivingEmails['em-4'] = {
    from: 'jamie@example.com',
    text: "Sure, let's do Thursday.\n\nOn Aug 3, 2026, at 10:00 AM, MTM Support <noreply@mail.microtrainingmethod.com> wrote:\n> Can you do Thursday?\n>\n> Thanks,\n> MTM Support",
  }
  const s4 = await postWebhook(webhook, receivedEvent('em-4', T_QUOTED, 'jamie@example.com'))
  ok('200 ack', s4 === 200)
  ok('stored body is just what the member typed', messages[0]?.body === "Sure, let's do Thursday.")
  ok('quoted trail is gone', !String(messages[0]?.body).includes('wrote:') && !String(messages[0]?.body).includes('Can you do Thursday?'))
  ok('in_progress replying to in_progress does not move the stage', tickets[T_QUOTED].stage === 'in_progress')

  console.log('\n-- signature verification: reuses the existing Svix check unchanged --')
  reset()
  tickets[T_WAITING] = mkTicket(T_WAITING, { stage: 'waiting_on_member' })
  receivingEmails['em-5'] = { from: 'jamie@example.com', text: 'hello' }
  const s5 = await postWebhook(webhook, receivedEvent('em-5', T_WAITING, 'jamie@example.com'), { badSignature: true })
  ok('bad signature 400s, no new auth path', s5 === 400)
  ok('nothing appended on a bad signature', messages.length === 0)
  ok('stage untouched on a bad signature', tickets[T_WAITING].stage === 'waiting_on_member')

  console.log('\n-- a redelivered webhook (same email_id) does not double-append or re-flip a stale stage --')
  reset()
  tickets[T_WAITING] = mkTicket(T_WAITING, { stage: 'waiting_on_member' })
  receivingEmails['em-6'] = { from: 'jamie@example.com', text: 'first delivery' }
  await postWebhook(webhook, receivedEvent('em-6', T_WAITING, 'jamie@example.com'))
  ok('first delivery appended and flipped', messages.length === 1 && tickets[T_WAITING].stage === 'in_progress')
  // An admin acts on the ticket between the two webhook deliveries.
  tickets[T_WAITING].stage = 'escalated'
  const s6 = await postWebhook(webhook, receivedEvent('em-6', T_WAITING, 'jamie@example.com'))
  ok('redelivery still 200s', s6 === 200)
  ok('no duplicate message', messages.length === 1)
  ok('does NOT stomp the stage set since the first delivery', tickets[T_WAITING].stage === 'escalated')

  console.log('\n-- ticket id present but does not exist — dropped, not appended --')
  reset()
  const s7 = await postWebhook(webhook, receivedEvent('em-7', 'a9999999-9999-4999-8999-999999999999', 'jamie@example.com'))
  ok('200 ack', s7 === 200)
  ok('nothing appended', messages.length === 0)

  console.log('\n-- recipient with no parseable ticket id — dropped, not appended --')
  reset()
  const noTagEvent = {
    type: 'email.received', created_at: iso(NOW),
    data: { email_id: 'em-8', created_at: iso(NOW), from: 'jamie@example.com', to: ['hello@mail.microtrainingmethod.com'], bcc: [], cc: [], received_for: ['hello@mail.microtrainingmethod.com'], message_id: 'm-em-8', subject: 'Hi', attachments: [] },
  }
  const s8 = await postWebhook(webhook, noTagEvent)
  ok('200 ack', s8 === 200)
  ok('nothing appended', messages.length === 0)

  console.log('\n-- new/escalated stages are untouched by a reply (only waiting_on_member/resolved/closed hand the ball back) --')
  reset()
  tickets[T_UNCHANGED] = mkTicket(T_UNCHANGED, { stage: 'escalated' })
  receivingEmails['em-9'] = { from: 'jamie@example.com', text: 'any update?' }
  await postWebhook(webhook, receivedEvent('em-9', T_UNCHANGED, 'jamie@example.com'))
  ok('message still threads in', messages.length === 1)
  ok('escalated stage is left alone — a specialist already owns it', tickets[T_UNCHANGED].stage === 'escalated')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
