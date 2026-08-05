import { SignJWT, jwtVerify } from 'jose'
import type { IncomingMessage, ServerResponse } from 'http'
import { supabase } from './supabase'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)
const COOKIE_NAME = 'catm_session'

/**
 * How the holder proved identity when this session was minted.
 *
 * Sessions are otherwise interchangeable — a year-long cookie from a password
 * login looks exactly like one from an emailed link. `set-password` needs to
 * tell them apart: proving control of the inbox is what stands in for knowing
 * the current password on the forgot-password path.
 *
 * Absent on every token issued before this claim existed, which reads as
 * `password` — the safe default, since it is the origin with fewer powers.
 */
export type SessionOrigin = 'password' | 'magic_link'

export async function createSessionToken(
  userId: string,
  opts: { origin?: SessionOrigin } = {}
): Promise<string> {
  const origin: SessionOrigin = opts.origin ?? 'password'
  return new SignJWT({ userId, origin })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1y')
    .sign(JWT_SECRET)
}

export type SessionClaims = {
  userId: string
  origin: SessionOrigin
  /** Unix seconds the token was minted. Absent only on a malformed token. */
  issuedAt: number | null
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return {
      userId: payload.userId as string,
      // Unknown/legacy values collapse to 'password' rather than being trusted
      // as-is, so a token cannot claim an origin the app does not recognise.
      origin: payload.origin === 'magic_link' ? 'magic_link' : 'password',
      issuedAt: typeof payload.iat === 'number' ? payload.iat : null,
    }
  } catch {
    return null
  }
}

/**
 * How long a magic-link session keeps the right to set a password without
 * knowing the current one. The link itself lives 15 minutes; this is the window
 * AFTER landing, generous enough for someone reading the email on a phone and
 * finishing on a laptop, short enough that a year-old session cannot be
 * replayed into a takeover.
 *
 * Expiry is not a lockout: the member requests another link and gets a fresh
 * window, which is exactly what the 403 tells them to do.
 */
export const MAGIC_LINK_PASSWORD_GRACE_SECONDS = 60 * 60

/**
 * True when this session was minted by a magic link recently enough to stand in
 * for the current password. Returns false for a token with no `iat` — an
 * unstampable token cannot be shown to be fresh.
 */
export function canSetPasswordWithoutCurrent(
  claims: Pick<SessionClaims, 'origin' | 'issuedAt'>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (claims.origin !== 'magic_link') return false
  if (typeof claims.issuedAt !== 'number') return false
  const age = nowSeconds - claims.issuedAt
  // A token stamped in the future is a clock skew or a forgery; neither earns
  // the grace window.
  if (age < 0) return false
  return age <= MAGIC_LINK_PASSWORD_GRACE_SECONDS
}

export function getSessionFromRequest(req: any): string | null {
  // Check Authorization header first (for cross-domain apps)
  const authHeader = req.headers['authorization'] || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  // Fall back to cookie
  const cookieHeader = req.headers['cookie'] || ''
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map((c: string) => c.trim().split('=').map(decodeURIComponent))
      .filter((parts: string[]) => parts.length === 2)
  )
  return cookies[COOKIE_NAME] ?? null
}

export function setSessionCookie(res: ServerResponse, token: string) {
  const maxAge = 60 * 60 * 24 * 365 // 1 year
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`
  )
}

export function clearSessionCookie(res: ServerResponse) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`
  )
}

// CORS preflight helper
export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers['origin'] || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

// Parse JSON body from incoming request
export async function parseBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch { reject(new Error('Invalid JSON')) }
    })
  })
}

// Standard JSON response helper
export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Auth gate for protected endpoints. Verifies the session token and ensures
 * the account is active. On failure it writes the error response (401
 * Unauthorized or 403 account_suspended) and returns null; the caller should
 * `return` immediately. On success it returns the userId.
 */
export async function requireActiveUser(req: any, res: any): Promise<string | null> {
  const claims = await requireActiveSession(req, res)
  return claims ? claims.userId : null
}

/**
 * Same gate as requireActiveUser, but hands back the whole verified claim set
 * instead of just the id. Only endpoints that care HOW the session was proved
 * need this — today that is set-password alone.
 */
export async function requireActiveSession(req: any, res: any): Promise<SessionClaims | null> {
  const token = getSessionFromRequest(req)
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  const payload = await verifySessionToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }

  const { data } = await supabase
    .from('users')
    .select('status')
    .eq('id', payload.userId)
    .single()

  if (data?.status === 'suspended') {
    res.status(403).json({ error: 'account_suspended' })
    return null
  }

  return payload
}

/**
 * Admin gate. Composes requireActiveUser, then checks users.role === 'admin'.
 * Writes the error response (401 / 403 account_suspended / 403 Forbidden) and
 * returns null on failure; returns the userId on success.
 */
export async function requireAdmin(req: any, res: any): Promise<string | null> {
  const userId = await requireActiveUser(req, res)
  if (!userId) return null

  const { data } = await supabase.from('users').select('role').eq('id', userId).single()
  if (!data || data.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  return userId
}
