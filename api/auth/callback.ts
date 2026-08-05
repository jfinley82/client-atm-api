import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { createSessionToken, setSessionCookie } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { APP_URL } from '../../lib/appUrls'



export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'GET') return res.status(405).end()

  const { token } = req.query

  if (!token || typeof token !== 'string') {
    return res.redirect(`${APP_URL}/?error=missing_token`)
  }

  try {
    // Look up token
    const { data: magicToken, error } = await supabase
      .from('magic_link_tokens')
      .select('*, users(*)')
      .eq('token', token)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (error || !magicToken) {
      return res.redirect(`${APP_URL}/?error=invalid_token`)
    }

    // Block suspended accounts before issuing a session token
    if (magicToken.users?.status === 'suspended') {
      return res.redirect(`${APP_URL}/?error=account_suspended`)
    }

    // Mark token as used
    await supabase
      .from('magic_link_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', magicToken.id)

    // Create session JWT. Stamped as magic_link: the holder just proved control
    // of the account's inbox, which is what lets set-password accept a new
    // password without the current one on the forgot-password path.
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
