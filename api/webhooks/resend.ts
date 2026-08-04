import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'
import { cancelLeadQueue } from '../../lib/funnelNurture'
import { resend } from '../../lib/email'
import { appendTicketMessage, nextStageForMemberReply, stageTimestampUpdates, TicketStage } from '../../lib/support'
import { stripQuotedReply } from '../../lib/emailReply'

// POST /api/webhooks/resend — Resend (Svix) delivery webhooks for funnel emails.
//
// Mirrors the raw-body + verify-signature pattern of api/stripe/webhook.ts and
// api/zoom/webhook.ts. Resend signs with Svix: headers svix-id / svix-timestamp
// / svix-signature, secret RESEND_WEBHOOK_SECRET ("whsec_<base64>"). A bad
// signature is rejected 400; everything else resolves the send by message id and
// records engagement.
//
// Handled events:
//   email.sent / email.delivered -> stamp funnel_email_sends.sent_at /
//     delivered_at (and settle a scheduled row's status). These are what the
//     per-email analytics feed divides by.
//   email.opened  -> funnel_events 'email_opened' (deduped to one per message)
//   email.clicked -> funnel_events 'email_clicked' (every click; stores the url)
//   email.bounced    -> status='failed' + bounced_at; unsubscribe the lead +
//     cancel their still-queued sends (so 5b's nurture engine skips them).
//   email.complained -> complained_at ONLY (delivered_at/status untouched — a
//     complaint means it WAS delivered, unlike a bounce); same unsubscribe +
//     cancel as a bounce, since either way this lead should get no more mail.
//   email.received -> Support Desk inbound replies (Phase 1b). The ticket's
//     notification emails set replyTo to support+<ticket id>@..., so a
//     member's reply carries its own ticket id in the `to` address. This
//     event is metadata only (sender/recipient/subject/ids, no body) — one
//     follow-up call to Resend's receiving-emails API gets the actual text.
//     See handleInboundTicketReply below.
// Attribution is always via funnel_email_sends.resend_message_id — the send row
// we wrote at send time — never via client-supplied data.
export const config = {
  api: { bodyParser: false },
}

function getRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Svix signature verification. signedContent = `${id}.${timestamp}.${body}`,
// HMAC-SHA256 keyed by the base64-decoded secret (after the whsec_ prefix),
// base64-encoded. The svix-signature header is a space-separated list of
// `v1,<sig>`; any matching entry passes. Timestamp is checked against a 5-minute
// tolerance to blunt replay. Constant-time compare.
function verifySvix(secret: string, id: string, timestamp: string, body: string, header: string): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

  let keyBytes: Buffer
  try {
    keyBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  } catch {
    return false
  }
  const expected = crypto.createHmac('sha256', keyBytes).update(`${id}.${timestamp}.${body}`).digest('base64')
  const eb = Buffer.from(expected)

  return header.split(' ').some((part) => {
    const comma = part.indexOf(',')
    if (comma < 0) return false
    const version = part.slice(0, comma)
    const sig = part.slice(comma + 1)
    if (version !== 'v1' || !sig) return false
    const sb = Buffer.from(sig)
    return sb.length === eb.length && crypto.timingSafeEqual(sb, eb)
  })
}

type ResendSend = { funnel_id: string; lead_id: string | null; kind: string }

async function lookupSend(messageId: string): Promise<ResendSend | null> {
  if (!messageId) return null
  const { data } = await supabase
    .from('funnel_email_sends')
    .select('funnel_id, lead_id, kind')
    .eq('resend_message_id', messageId)
    .maybeSingle()
  return (data as ResendSend) ?? null
}

// Stamp opened_at/clicked_at + bump the counter on the send row, and hand back
// the row that matched — one atomic statement (migration 074), so a repeated
// open can never move the first-touch timestamp and two simultaneous pixel
// fires can't lose a count to each other.
//
// Falls back to a plain lookup when the RPC is unavailable: code deploys and
// migrations are separate steps, and until 074 lands this function does not
// exist. Degrading to today's behavior (funnel_events row written, no stamp) is
// right — dropping the engagement entirely because the column isn't there yet
// would lose data we cannot get back.
async function recordEngagement(messageId: string, event: 'opened' | 'clicked'): Promise<ResendSend | null> {
  if (!messageId) return null
  const { data, error } = await supabase.rpc('record_email_engagement', {
    p_message_id: messageId,
    p_event: event,
    p_at: new Date().toISOString(),
  })
  if (error) {
    console.error('[webhooks/resend] engagement stamp failed — falling back to lookup', error)
    return lookupSend(messageId)
  }
  const row = (Array.isArray(data) ? data[0] : null) as ResendSend | null
  return row ?? null
}

const TICKET_ID_RE = /^support\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i

// The plus-tag rides in `to`, but `received_for` is Resend's own record of
// which of your domain's addresses actually captured the mail — checked
// first since it's the more precise of the two when there's more than one
// recipient (e.g. the member CC'd someone).
function ticketIdFromRecipients(data: { to?: unknown; received_for?: unknown }): string | null {
  const candidates = [
    ...(Array.isArray(data.received_for) ? data.received_for : []),
    ...(Array.isArray(data.to) ? data.to : []),
  ]
  for (const addr of candidates) {
    if (typeof addr !== 'string') continue
    const m = TICKET_ID_RE.exec(addr.trim())
    if (m) return m[1].toLowerCase()
  }
  return null
}

// "Jamie Coach <jamie@example.com>" -> "jamie@example.com". Resend's `from`
// on the webhook event is a raw header value, not pre-parsed.
function bareEmail(raw: string): string {
  const m = /<([^>]+)>/.exec(raw)
  return (m ? m[1] : raw).trim().toLowerCase()
}

// Best-effort plaintext fallback for the rare inbound message with no
// text/plain part (an HTML-only mail client). Dropping the reply entirely
// because of that would be a worse outcome than a slightly rough rendering.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

// email.received -> thread the member's reply into support_ticket_messages,
// and hand the ball back if the ticket was waiting on them.
//
// Ordered to fail cheap: parse + look up the ticket, verify the sender BEFORE
// spending the one paid follow-up call (receiving.get) on a request that's
// going to be dropped anyway.
async function handleInboundTicketReply(data: any): Promise<void> {
  const ticketId = ticketIdFromRecipients(data)
  if (!ticketId) {
    console.warn('[webhooks/resend] inbound email: no ticket id in recipients', data?.to, data?.received_for)
    return
  }

  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('id, user_id, stage, first_response_at, resolved_at')
    .eq('id', ticketId)
    .maybeSingle()
  if (!ticket) {
    console.warn('[webhooks/resend] inbound email: unknown ticket', ticketId)
    return
  }

  const { data: owner } = await supabase.from('users').select('email').eq('id', (ticket as any).user_id).maybeSingle()
  const ownerEmail = typeof (owner as any)?.email === 'string' ? (owner as any).email.toLowerCase() : ''
  const fromEmail = bareEmail(String(data?.from || ''))

  // Anyone who learned or guessed a support+<id>@ address could otherwise
  // inject a message into someone else's ticket. Flagged and dropped, not
  // appended — the mismatch is logged for follow-up, never silently ignored.
  if (!ownerEmail || !fromEmail || fromEmail !== ownerEmail) {
    console.warn('[webhooks/resend] inbound email: sender mismatch, dropped', { ticketId, from: fromEmail, expected: ownerEmail })
    return
  }

  const emailId = typeof data?.email_id === 'string' ? data.email_id : ''
  if (!emailId) {
    console.warn('[webhooks/resend] inbound email: missing email_id', ticketId)
    return
  }

  const { data: received, error: fetchErr } = await resend.emails.receiving.get(emailId)
  if (fetchErr || !received) {
    console.error('[webhooks/resend] inbound email: fetch failed', ticketId, fetchErr)
    return
  }

  const raw = (received.text || (received.html ? htmlToText(received.html) : '') || '').trim()
  if (!raw) {
    console.warn('[webhooks/resend] inbound email: empty body, dropped', ticketId)
    return
  }
  // Trim the quoted thread so the stored message is what the member typed,
  // not their words with our last email repeated underneath.
  const bodyText = stripQuotedReply(raw)

  const appended = await appendTicketMessage({
    ticketId: (ticket as any).id,
    authorUserId: (ticket as any).user_id,
    authorRole: 'member',
    body: bodyText,
    resendEmailId: emailId,
  })
  if (!appended) return

  // A webhook redelivery of an already-processed email must not re-flip the
  // stage using this now-stale ticket snapshot — an admin may have moved it
  // again since the first delivery.
  if (appended.alreadyProcessed) {
    console.log('[webhooks/resend] inbound email: duplicate delivery, already processed', emailId)
    return
  }

  const nextStage = nextStageForMemberReply((ticket as any).stage as TicketStage)
  if (nextStage) {
    const nowIso = new Date().toISOString()
    const updates = { ...stageTimestampUpdates(nextStage, ticket as any, nowIso), stage: nextStage, updated_at: nowIso }
    const { error: updErr } = await supabase.from('support_tickets').update(updates).eq('id', (ticket as any).id)
    if (updErr) console.error('[webhooks/resend] inbound email: stage flip failed', ticketId, updErr)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhooks/resend] RESEND_WEBHOOK_SECRET not set — cannot verify')
    return res.status(500).json({ error: 'webhook_not_configured' })
  }

  let raw: string
  try {
    raw = await getRawBody(req)
  } catch (err) {
    console.error('[webhooks/resend] body read failed', err)
    return res.status(400).json({ error: 'bad_request' })
  }

  const svixId = req.headers['svix-id'] as string | undefined
  const svixTs = req.headers['svix-timestamp'] as string | undefined
  const svixSig = req.headers['svix-signature'] as string | undefined
  if (!svixId || !svixTs || !svixSig || !verifySvix(secret, svixId, svixTs, raw, svixSig)) {
    console.warn('[webhooks/resend] signature verification failed')
    return res.status(400).json({ error: 'invalid_signature' })
  }

  let body: { type?: string; data?: any }
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    return res.status(400).json({ error: 'invalid_json' })
  }

  const type = body.type
  const messageId = typeof body.data?.email_id === 'string' ? body.data.email_id : ''

  try {
    // Delivery lifecycle. Without these two the analytics feed has no honest
    // denominator: a SCHEDULED send is recorded 'queued' at schedule time and
    // nothing ever moved it, so every future-dated email looked unsent forever.
    // email.sent is when Resend dispatched it; email.delivered is when the
    // receiving server accepted it, which is what open/click rates divide by.
    if (type === 'email.sent' || type === 'email.delivered') {
      if (messageId) {
        const stamp = { [type === 'email.sent' ? 'sent_at' : 'delivered_at']: new Date().toISOString() }
        // Also settle the status for a scheduled send that has now gone out.
        // Never overwrite 'failed' — a later delivered event for a bounced
        // message would otherwise erase the bounce.
        const { error } = await supabase
          .from('funnel_email_sends')
          .update({ ...stamp, status: 'sent' })
          .eq('resend_message_id', messageId)
          .neq('status', 'failed')
        if (error) console.error('[webhooks/resend] delivery update', error)
      }
      return res.status(200).json({ received: true })
    }

    if (type === 'email.opened' || type === 'email.clicked') {
      const isOpen = type === 'email.opened'
      // Stamps the send row AND resolves it in one round trip.
      const send = await recordEngagement(messageId, isOpen ? 'opened' : 'clicked')
      // No matching send row (e.g. a non-funnel email) → nothing to attribute.
      if (!send) return res.status(200).json({ received: true })

      const metadata: Record<string, unknown> = { resend_message_id: messageId, kind: send.kind }
      if (!isOpen && typeof body.data?.click?.link === 'string') metadata.url = body.data.click.link

      const { error } = await supabase.from('funnel_events').insert({
        funnel_id: send.funnel_id,
        lead_id: send.lead_id,
        event_type: isOpen ? 'email_opened' : 'email_clicked',
        metadata,
      })
      // Opens: the partial unique index makes a repeat a benign 23505.
      if (error && (error as { code?: string }).code !== '23505') {
        console.error('[webhooks/resend] event insert', error)
      }
      return res.status(200).json({ received: true })
    }

    if (type === 'email.bounced' || type === 'email.complained') {
      const send = await lookupSend(messageId)
      if (send) {
        // Bounced and complained are DISTINCT outcomes, not the same failure:
        // a bounce means the message was never delivered; a complaint requires
        // the opposite — it was delivered, and the recipient then marked it
        // spam. Stamping both the same way (as this used to) corrupted both
        // the bounce rate and any complaint/spam rate. A bounce marks the send
        // failed; a complaint stamps complained_at only and leaves
        // delivered_at/status exactly as the delivery webhook already set them.
        if (type === 'email.bounced') {
          await supabase
            .from('funnel_email_sends')
            .update({ status: 'failed', bounced_at: new Date().toISOString() })
            .eq('resend_message_id', messageId)
        } else {
          await supabase
            .from('funnel_email_sends')
            .update({ complained_at: new Date().toISOString() })
            .eq('resend_message_id', messageId)
        }
        if (send.lead_id) {
          // Suppress the lead and cancel any of their still-scheduled sends —
          // cancelLeadQueue also cancels them at Resend (Phase 5b), not just in
          // our table. Applies to both: a bounced address is undeliverable and
          // a complaint means they explicitly don't want this mail.
          await supabase.from('funnel_leads').update({ email_unsubscribed: true }).eq('id', send.lead_id)
          await cancelLeadQueue(send.lead_id)
        }
      }
      return res.status(200).json({ received: true })
    }

    if (type === 'email.received') {
      await handleInboundTicketReply(body.data || {})
      return res.status(200).json({ received: true })
    }

    // Any other subscribed event: acknowledged no-op.
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[webhooks/resend] handler error', err)
    // Still 2xx so Resend doesn't retry-storm on a transient DB blip.
    return res.status(200).json({ received: true })
  }
}
