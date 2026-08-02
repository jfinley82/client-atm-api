import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'
import { cancelLeadQueue } from '../../lib/funnelNurture'

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

    // Any other subscribed event: acknowledged no-op.
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[webhooks/resend] handler error', err)
    // Still 2xx so Resend doesn't retry-storm on a transient DB blip.
    return res.status(200).json({ received: true })
  }
}
