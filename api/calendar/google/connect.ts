import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'
import { isGoogleConfigured, signOAuthState, buildConsentUrl } from '../../../lib/googleCalendar'
import { isTokenKeyConfigured } from '../../../lib/cryptoTokens'

const APP_URL = process.env.APP_URL || 'https://app.microtrainingmethod.com'

// GET /api/calendar/google/connect — authed. Redirects the coach to Google's
// consent screen (offline access + forced consent so we get a refresh token),
// with a signed state bound to their userId for CSRF protection on the callback.
// Top-level navigation, so the session travels via the catm cookie or ?token.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    return res.redirect(302, `${APP_URL}/funnel-settings?gcal=error&reason=not_configured`)
  }

  const state = await signOAuthState(userId)
  return res.redirect(302, buildConsentUrl(state))
}
