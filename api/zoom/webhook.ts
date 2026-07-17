import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'

// POST /api/zoom/webhook — receives Zoom event notifications.
//
// Two jobs:
//   1. URL validation (CRC): Zoom's "Validate" button and periodic re-checks
//      POST { event: 'endpoint.url_validation', payload: { plainToken } }. We
//      must reply 200 with { plainToken, encryptedToken }, where encryptedToken
//      is HMAC-SHA256(plainToken) keyed by the app's Secret Token. This is what
//      the dashboard's "URL validation failed" is waiting on.
//   2. Real events: verified via the x-zm-signature header, then handled.
//      meeting.deleted -> flip the matching active booking to 'canceled',
//      which frees the slot (the partial unique index only covers active rows).
//
// Raw body is required for signature verification, so the default JSON parser
// is disabled (same approach as api/stripe/webhook.ts).
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN
  if (!secretToken) {
    console.error('[zoom/webhook] ZOOM_WEBHOOK_SECRET_TOKEN not set — cannot validate')
    return res.status(500).json({ error: 'webhook_not_configured' })
  }

  let raw: string
  try {
    raw = await getRawBody(req)
  } catch (err) {
    console.error('[zoom/webhook] body read failed', err)
    return res.status(400).json({ error: 'bad_request' })
  }

  let body: { event?: string; payload?: any }
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    return res.status(400).json({ error: 'invalid_json' })
  }

  // 1) CRC URL-validation handshake.
  if (body.event === 'endpoint.url_validation' && body.payload?.plainToken) {
    const plainToken = body.payload.plainToken as string
    const encryptedToken = crypto.createHmac('sha256', secretToken).update(plainToken).digest('hex')
    return res.status(200).json({ plainToken, encryptedToken })
  }

  // 2) Verify the signature on real events:
  //    x-zm-signature = 'v0=' + HMAC-SHA256(secret, 'v0:' + timestamp + ':' + rawBody)
  const signature = req.headers['x-zm-signature'] as string | undefined
  const timestamp = req.headers['x-zm-request-timestamp'] as string | undefined
  if (signature && timestamp) {
    const expected = 'v0=' + crypto.createHmac('sha256', secretToken).update(`v0:${timestamp}:${raw}`).digest('hex')
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[zoom/webhook] signature mismatch — ignoring event', { event: body.event })
      return res.status(401).json({ error: 'invalid_signature' })
    }
  } else {
    // A real event with no signature headers is not from Zoom — ignore.
    console.warn('[zoom/webhook] event without signature headers — ignoring', { event: body.event })
    return res.status(401).json({ error: 'invalid_signature' })
  }

  try {
    // meeting.deleted: cancel the matching booking so its slot reopens.
    if (body.event === 'meeting.deleted') {
      const meetingId = body.payload?.object?.id
      if (meetingId != null) {
        const { error } = await supabase
          .from('bookings')
          .update({ status: 'canceled' })
          .eq('zoom_meeting_id', String(meetingId))
          .eq('status', 'active')
        if (error) console.error('[zoom/webhook] cancel booking failed', error)
      }
    }
    // Other subscribed events fall through as an acknowledged no-op.
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[zoom/webhook] handler error', err)
    // Still 200 so Zoom doesn't retry-storm on a transient DB blip.
    return res.status(200).json({ received: true })
  }
}
