import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'

// POST /api/webhooks/resend — Resend (Svix) delivery webhooks for funnel emails.
//
// Mirrors the raw-body + verify-signature pattern of api/stripe/webhook.ts and
// api/zoom/webhook.ts. Resend signs with Svix: headers svix-id / svix-timestamp
// / svix-signature, secret RESEND_WEBHOOK_SECRET ("whsec_<base64>"). A bad
// signature is rejected 400; everything else resolves the send by message id and
// records engagement.
//
// Handled events:
//   email.opened  -> funnel_events 'email_opened' (deduped to one per message)
//   email.clicked -> funnel_events 'email_clicked' (every click; stores the url)
//   email.bounced / email.complained -> unsubscribe the lead + cancel their
//     still-queued sends (so 5b's nurture engine skips them)
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
    if (type === 'email.opened' || type === 'email.clicked') {
      const send = await lookupSend(messageId)
      // No matching send row (e.g. a non-funnel email) → nothing to attribute.
      if (!send) return res.status(200).json({ received: true })

      const isOpen = type === 'email.opened'
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
        // Mark this specific send failed.
        await supabase.from('funnel_email_sends').update({ status: 'failed' }).eq('resend_message_id', messageId)
        if (send.lead_id) {
          // Suppress the lead and cancel any of their still-queued sends.
          await supabase.from('funnel_leads').update({ email_unsubscribed: true }).eq('id', send.lead_id)
          await supabase
            .from('funnel_email_sends')
            .update({ status: 'canceled' })
            .eq('lead_id', send.lead_id)
            .eq('status', 'queued')
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
