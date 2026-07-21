import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors } from '../../../lib/cors'
import {
  verifyOAuthState,
  nonceMatches,
  exchangeCode,
  fetchPrimaryEmail,
  saveGoogleConnection,
  isGoogleConfigured,
} from '../../../lib/googleCalendar'
import { isTokenKeyConfigured } from '../../../lib/cryptoTokens'

const APP_URL = process.env.APP_URL || 'https://app.microtrainingmethod.com'
const NONCE_COOKIE = 'catm_gcal_nonce'
// Clears the one-time nonce cookie set at connect.
const CLEAR_NONCE = `${NONCE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`

function readCookie(req: VercelRequest, name: string): string | undefined {
  const header = (req.headers.cookie as string) || ''
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

function back(res: VercelResponse, params: string) {
  res.setHeader('Set-Cookie', CLEAR_NONCE)
  return res.redirect(302, `${APP_URL}/funnel-settings?${params}`)
}

// GET /api/calendar/google/callback — PUBLIC. Google redirects here with ?code &
// ?state (or ?error). The state is a signed token bound to the userId, so this
// endpoint trusts it rather than a session. Exchanges the code, stores the
// (encrypted-refresh) tokens, then redirects back to the app with a flag.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const q = req.query
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const code = one(q.code) as string | undefined
  const state = one(q.state) as string | undefined
  const oauthError = one(q.error) as string | undefined

  if (oauthError) return back(res, `gcal=error&reason=${encodeURIComponent(oauthError)}`)
  if (!code || !state) return back(res, 'gcal=error&reason=missing_params')
  if (!isGoogleConfigured() || !isTokenKeyConfigured()) return back(res, 'gcal=error&reason=not_configured')

  // CSRF: the state must be our signed, unexpired token for this flow AND the
  // per-flow nonce cookie must match the hash bound into it — so this callback
  // can only complete the session that started the connect (blocks OAuth
  // account-linking: an attacker's state can't be completed in a victim's browser).
  const verified = await verifyOAuthState(state)
  if (!verified) return back(res, 'gcal=error&reason=bad_state')
  if (!nonceMatches(readCookie(req, NONCE_COOKIE), verified.nonceHash)) {
    return back(res, 'gcal=error&reason=bad_state')
  }

  try {
    const tokens = await exchangeCode(code)
    if (!tokens.access_token) return back(res, 'gcal=error&reason=exchange_failed')

    const email = await fetchPrimaryEmail(tokens.access_token)
    await saveGoogleConnection(verified.userId, tokens, email)

    return back(res, 'gcal=connected')
  } catch (err) {
    console.error('[calendar/google/callback]', err)
    return back(res, 'gcal=error&reason=server_error')
  }
}
