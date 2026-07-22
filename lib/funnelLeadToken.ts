import crypto from 'crypto'

// Signed, purpose-scoped tokens that NAME a (funnel, lead) pair for public
// funnel flows — never a session credential and never granting access.
//
// Each purpose derives its OWN key from JWT_SECRET with a distinct HMAC label
// (the discipline googleCalendar's STATE_SECRET uses). Distinct keys mean a
// token minted for one purpose can never verify as another, and none can verify
// as a session token. The payload is the plain string "funnelId.leadId.expMs";
// funnel/lead ids are UUIDs (no dots) and both token segments are base64url
// (no dots), so the single '.' split is unambiguous.
//
//   watch (Phase 4/5b): 24h — attributes a video beacon to the lead; the
//     training link carries it as ?wt=.
//   unsub (Phase 5b): 1 year — the unsubscribe link in nurture emails; long
//     lived so an email opened weeks later still works. Decoded WITHOUT a known
//     funnel id (the endpoint only has the token).
function deriveSecret(label: string): Buffer {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(label).digest()
}
const WATCH_SECRET = deriveSecret('funnel-lead-watch-v1')
const UNSUB_SECRET = deriveSecret('funnel-lead-unsub-v1')

const WATCH_TTL_MS = 24 * 60 * 60 * 1000
const UNSUB_TTL_MS = 365 * 24 * 60 * 60 * 1000

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// Token = "<base64url(payload)>.<base64url(hmac)>", payload = "funnelId.leadId.expMs".
function signWith(secret: Buffer, funnelId: string, leadId: string, ttlMs: number, nowMs: number): string {
  const payload = `${funnelId}.${leadId}.${nowMs + ttlMs}`
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${b64url(Buffer.from(payload, 'utf8'))}.${sig}`
}

// Verify signature + expiry and return the decoded { funnelId, leadId }, or null
// on any failure (tampered, expired, malformed). Constant-time signature compare.
// Does NOT check the funnel binding — callers that know the funnel check it.
function verifyWith(secret: Buffer, token: unknown, nowMs: number): { funnelId: string; leadId: string } | null {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null

  let payload: string
  try {
    payload = fromB64url(parts[0]).toString('utf8')
  } catch {
    return null
  }

  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(parts[1])
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const segs = payload.split('.')
  if (segs.length !== 3) return null
  const [funnelId, leadId, expStr] = segs
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || nowMs >= exp) return null
  if (!funnelId || !leadId) return null
  return { funnelId, leadId }
}

// ---- watch token (Phase 4) --------------------------------------------------

export function signWatchToken(funnelId: string, leadId: string, nowMs: number = Date.now()): string {
  return signWith(WATCH_SECRET, funnelId, leadId, WATCH_TTL_MS, nowMs)
}

// Returns the lead_id when the token is valid AND bound to `expectedFunnelId`,
// else null (so the caller falls back to an anonymous funnel-level event).
export function verifyWatchToken(token: unknown, expectedFunnelId: string, nowMs: number = Date.now()): string | null {
  const decoded = verifyWith(WATCH_SECRET, token, nowMs)
  if (!decoded || decoded.funnelId !== expectedFunnelId) return null
  return decoded.leadId
}

// ---- unsubscribe token (Phase 5b) -------------------------------------------

export function signUnsubscribeToken(funnelId: string, leadId: string, nowMs: number = Date.now()): string {
  return signWith(UNSUB_SECRET, funnelId, leadId, UNSUB_TTL_MS, nowMs)
}

// The unsubscribe endpoint has only the token, so this returns the decoded
// { funnelId, leadId } (or null). The endpoint then loads the lead by these ids.
export function verifyUnsubscribeToken(token: unknown, nowMs: number = Date.now()): { funnelId: string; leadId: string } | null {
  return verifyWith(UNSUB_SECRET, token, nowMs)
}
