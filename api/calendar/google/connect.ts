import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { setCors } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'
import { isGoogleConfigured, signOAuthState, buildConsentUrl, hashNonce } from '../../../lib/googleCalendar'
import { isTokenKeyConfigured } from '../../../lib/cryptoTokens'

const APP_URL = process.env.APP_URL || 'https://app.microtrainingmethod.com'
const NONCE_COOKIE = 'catm_gcal_nonce'

// GET /api/calendar/google/connect — authed. Sets a per-flow nonce cookie, then
// redirects the coach to Google's consent screen (offline access + forced
// consent for a refresh token) with a signed state bound to their userId AND the
// nonce's hash. The callback requires the cookie to match, so the flow can't be
// completed by (or linked into) a different session.
//
// This is a top-level navigation, so the session must travel via the catm
// session COOKIE (a top-level nav can't carry an Authorization: Bearer header).
// A Bearer-only frontend should instead fetch this endpoint authed, read the
// redirect Location, and navigate to it. SameSite=Lax lets both the nonce cookie
// here and the session cookie survive the Google round-trip.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    return res.redirect(302, `${APP_URL}/funnel-settings?gcal=error&reason=not_configured`)
  }

  const nonce = crypto.randomBytes(32).toString('hex')
  const state = await signOAuthState(userId, hashNonce(nonce))
  res.setHeader(
    'Set-Cookie',
    `${NONCE_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  )
  return res.redirect(302, buildConsentUrl(state))
}
