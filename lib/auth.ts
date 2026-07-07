import { SignJWT, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose'
import type { IncomingMessage, ServerResponse } from 'http'
import { supabase } from './supabase'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)
const COOKIE_NAME = 'catm_session'

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1y')
    .sign(JWT_SECRET)
}

export async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return { userId: payload.userId as string }
  } catch (e: any) {
    // TEMPORARY diagnostic — the bare `catch { return null }` hid WHY a token
    // was rejected (signature vs expiry vs malformed). Decode the token WITHOUT
    // verifying to surface its header/claims alongside the real jose error, so a
    // browser-valid token that 401s from the script can be pinned to a specific
    // mechanism. Logs no secrets and only a masked slice of the token. Revert
    // once the auth failure is diagnosed.
    let hdr: any = null
    let claims: any = null
    try { hdr = decodeProtectedHeader(token) } catch {}
    try { claims = decodeJwt(token) } catch {}
    console.error('[auth] verifySessionToken REJECT', {
      err_name: e?.constructor?.name,
      err_code: e?.code,
      err_msg: e?.message,
      token_len: token.length,
      token_head: token.slice(0, 12),
      token_tail: token.slice(-6),
      alg: hdr?.alg,
      typ: hdr?.typ,
      claim_userId: claims?.userId,
      claim_exp: claims?.exp,
      claim_iat: claims?.iat,
      now_epoch: Math.floor(Date.now() / 1000),
      secret_len: (process.env.JWT_SECRET || '').length,
    })
    return null
  }
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
  const token = getSessionFromRequest(req)
  if (!token) {
    // TEMPORARY diagnostic — distinguishes "no Authorization header arrived"
    // from "header arrived but was rejected" (the latter logs in
    // verifySessionToken). Revert with the other auth diagnostics.
    console.error('[auth] 401 no token extracted', {
      has_authorization: !!req.headers['authorization'],
      authorization_prefix: String(req.headers['authorization'] || '').slice(0, 8),
      has_cookie: !!req.headers['cookie'],
      path: req.url,
    })
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

  return payload.userId
}
