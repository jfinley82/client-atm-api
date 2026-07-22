import crypto from 'crypto'

// Short-lived signed "watch token" that NAMES the lead who opted in, so a public
// video beacon (POST /api/funnel/event) can attribute the watch to that lead.
//
// The signing key is DERIVED from JWT_SECRET with a distinct HMAC label — never
// JWT_SECRET itself — exactly the discipline googleCalendar's STATE_SECRET uses.
// A separate key means this token can never verify as a session token, and a
// session token can never be replayed here. The token grants NO access; it only
// binds (funnel_id, lead_id) with an expiry, so a compact opaque HMAC is enough.
const WATCH_SECRET = crypto.createHmac('sha256', process.env.JWT_SECRET || '').update('funnel-lead-watch-v1').digest()

const TTL_MS = 24 * 60 * 60 * 1000 // 24h — spans a page-open-and-watch, not more.

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// Token = "<base64url(payload)>.<base64url(hmac)>" where payload is the plain
// string "funnelId.leadId.expMs". funnel/lead ids are UUIDs (no dots) and both
// segments are base64url (no dots), so a single '.' split is unambiguous.
export function signWatchToken(funnelId: string, leadId: string, nowMs: number = Date.now()): string {
  const payload = `${funnelId}.${leadId}.${nowMs + TTL_MS}`
  const sig = b64url(crypto.createHmac('sha256', WATCH_SECRET).update(payload).digest())
  return `${b64url(Buffer.from(payload, 'utf8'))}.${sig}`
}

// Returns the lead_id when the token is well-formed, unexpired, signed by us, and
// bound to THIS funnel. Any failure (tampered, expired, wrong funnel, malformed)
// returns null so the caller falls back to an anonymous funnel-level event —
// never an error. Constant-time signature compare.
export function verifyWatchToken(token: unknown, expectedFunnelId: string, nowMs: number = Date.now()): string | null {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null

  let payload: string
  try {
    payload = fromB64url(parts[0]).toString('utf8')
  } catch {
    return null
  }

  const expected = b64url(crypto.createHmac('sha256', WATCH_SECRET).update(payload).digest())
  const a = Buffer.from(parts[1])
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const segs = payload.split('.')
  if (segs.length !== 3) return null
  const [funnelId, leadId, expStr] = segs
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || nowMs >= exp) return null
  if (!funnelId || !leadId || funnelId !== expectedFunnelId) return null
  return leadId
}
