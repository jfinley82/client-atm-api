import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { setCors } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'
import { isGoogleConfigured, signOAuthState, buildConsentUrl, hashNonce } from '../../../lib/googleCalendar'
import { isTokenKeyConfigured } from '../../../lib/cryptoTokens'
import { APP_URL } from '../../../lib/appUrls'


const NONCE_COOKIE = 'catm_gcal_nonce'

// GET /api/calendar/google/connect — authed. Sets a per-flow nonce cookie, then
// hands the caller Google's consent URL with a signed state bound to their
// userId AND the nonce's hash. The callback requires the cookie to match, so the
// flow can't be completed by (or linked into) a different session.
//
// TWO MODES, because a redirect is unreadable to the caller that needs it most.
//
//   default      302 to Google. A top-level navigation, so the session travels
//                via the catm session COOKIE — a top-level nav cannot carry an
//                Authorization header.
//   ?mode=url    200 { url }. The caller navigates itself.
//
// THE COMMENT THAT USED TO BE HERE WAS WRONG, and it cost the frontend a
// scouting round. It said a Bearer-only frontend should "fetch this endpoint
// authed, read the redirect Location, and navigate to it." That cannot work
// cross-origin, and app.→api. is cross-origin:
//
//   - redirect: 'manual' yields an opaqueredirect response. `Location` is not
//     readable. By design, not by configuration.
//   - redirect: 'follow' makes the browser follow to accounts.google.com, which
//     sends no CORS headers, so the fetch rejects.
//
// No header, CORS setting or fetch option makes a cross-origin 302 readable. It
// was a claim about the world that had never been executed. ?mode=url is what
// replaces it, and tests/googleConnect.test.ts drives both modes.
//
// WHY A QUERY PARAMETER RATHER THAN `Accept: application/json`:
//
//   - It is visible in the request line, so runtime logs distinguish the two
//     modes. "The connect button did nothing" is diagnosed from the log, and a
//     response type chosen by a header does not appear there.
//   - It cannot be triggered by accident. fetch() defaults to `Accept: */*`, and
//     a prefetch, extension or link scanner sending the same could flip a
//     top-level navigation into JSON. Content negotiation also fails silently in
//     the other direction: a caller that forgets the header gets the 302 it
//     cannot read, which is precisely the bug being fixed, returning unnoticed.
//   - It is probeable with a URL alone, which is what a human runbook has.
//
// THE COOKIE IS SET ON BOTH PATHS. Dropping it on the JSON path is the failure
// this design invites: the callback would then refuse every flow with a nonce
// mismatch. The chain works because the frontend fetches with
// `credentials: 'include'` and lib/cors.ts already sends
// Access-Control-Allow-Credentials, so the Set-Cookie lands on the API origin;
// Google later returns the browser to that same origin as a top-level GET, which
// is same-site, so the SameSite=Lax cookie is sent back.
//
// NO SESSION TOKEN IN THE URL. A short-lived signed token would also work and
// would put a credential in a query string, browser history and access logs, for
// nothing the JSON response does not already give.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  // BEFORE the mode branch, so both modes refuse an unauthenticated caller
  // identically — by construction rather than by two matching implementations.
  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const wantsJson = (Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode) === 'url'

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    // The JSON caller must not get a redirect here either — an opaque redirect
    // is exactly as unreadable for an error as it is for the consent URL.
    if (wantsJson) return res.status(503).json({ error: 'not_configured' })
    return res.redirect(302, `${APP_URL}/funnel-settings?gcal=error&reason=not_configured`)
  }

  const nonce = crypto.randomBytes(32).toString('hex')
  const state = await signOAuthState(userId, hashNonce(nonce))
  res.setHeader(
    'Set-Cookie',
    `${NONCE_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  )

  const url = buildConsentUrl(state)
  if (wantsJson) return res.status(200).json({ url })
  return res.redirect(302, url)
}
