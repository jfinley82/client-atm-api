import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { createSessionToken, setSessionCookie } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { APP_URL } from '../../lib/appUrls'

// The ONE redemption path, for both token kinds. A login link and an invite
// differ only in how long they live (lib/memberInvite.ts); everything that
// matters — single use, expiry, the suspended-account check, the session mint —
// happens here, once. A second table for invites would have forked exactly this
// code, which is the half worth not forking.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'GET') return res.status(405).end()

  const { token } = req.query

  if (!token || typeof token !== 'string') {
    return res.redirect(`${APP_URL}/?error=missing_token`)
  }

  try {
    // Fetched by token ALONE, then judged in code. The previous version put
    // `used_at is null` and `expires_at > now` in the query, which made an
    // expired token indistinguishable from one that never existed — both came
    // back empty and both redirected to invalid_token. That is fine for a login
    // link, whose owner is sitting on the login page and can ask for another.
    // It is the wrong answer for an invite: a workshop attendee opening the
    // email a week later gets an error that reads like the product is broken,
    // with nothing to do about it.
    const { data: magicToken, error } = await supabase
      .from('magic_link_tokens')
      .select('*, users(*)')
      .eq('token', token)
      .maybeSingle()

    if (error || !magicToken) {
      return res.redirect(`${APP_URL}/?error=invalid_token`)
    }

    // Single use. Enforced before expiry so a redeemed token reads the same
    // whether or not its window has since closed.
    if (magicToken.used_at) {
      return res.redirect(`${APP_URL}/?error=invalid_token`)
    }

    if (new Date(magicToken.expires_at).getTime() <= Date.now()) {
      // The one case that earns its own code: the invite page offers to send a
      // fresh link, which the member triggers themselves through
      // POST /api/auth/send-magic-link. No admin, no support request. The email
      // is deliberately NOT echoed into the URL — the page asks for it, so a
      // forwarded expired link cannot leak who it was issued to.
      const code = magicToken.kind === 'invite' ? 'invite_expired' : 'invalid_token'
      return res.redirect(`${APP_URL}/?error=${code}`)
    }

    // Block suspended accounts before issuing a session token
    if (magicToken.users?.status === 'suspended') {
      return res.redirect(`${APP_URL}/?error=account_suspended`)
    }

    // Mark token as used. Conditional on used_at still being null, so two
    // simultaneous clicks cannot both mint a session off one token.
    const { data: claimed } = await supabase
      .from('magic_link_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', magicToken.id)
      .is('used_at', null)
      .select('id')
      .maybeSingle()

    if (!claimed) {
      return res.redirect(`${APP_URL}/?error=invalid_token`)
    }

    // Create session JWT. Stamped as magic_link: the holder just proved control
    // of the account's inbox, which is what lets set-password accept a new
    // password without the current one. That is also how an invited member sets
    // their first password — an admin never sets one for them.
    const sessionToken = await createSessionToken(magicToken.user_id, { origin: 'magic_link' })
    setSessionCookie(res as any, sessionToken)

    // Redirect with token so cross-domain apps can store it client-side
    return res.redirect(302,
      `${APP_URL}/auth-callback?token=${encodeURIComponent(sessionToken)}`
    )

  } catch (err) {
    console.error('[auth/callback]', err)
    return res.redirect(`${APP_URL}/?error=server_error`)
  }
}
