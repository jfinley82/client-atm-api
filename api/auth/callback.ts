import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { createSessionToken, setSessionCookie } from '../../lib/auth'

const APP_URL = process.env.APP_URL || 'https://app.clientatmbuilder.com'

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    // Mark token as used
    await supabase
      .from('magic_link_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', magicToken.id)

    // Create session JWT
    const sessionToken = await createSessionToken(magicToken.user_id)
    setSessionCookie(res as any, sessionToken)

    // Redirect to dashboard
    const user = magicToken.users as any
    const destination = user?.has_paid
      ? `${APP_URL}/dashboard`
      : `${APP_URL}/dashboard`

    return res.redirect(302, destination)

  } catch (err) {
    console.error('[auth/callback]', err)
    return res.redirect(`${APP_URL}/?error=server_error`)
  }
}
