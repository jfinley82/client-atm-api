import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { supabase } from '../../lib/supabase'
import { requireActiveSession, canSetPasswordWithoutCurrent } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// POST /api/auth/set-password — set a password WITHOUT presenting the current
// one. Two legitimate callers, both arriving from an emailed link:
//
//   1. First-time setup. The account has no password_hash yet, so there is
//      nothing to verify and nothing an attacker could invalidate.
//   2. Forgot-password recovery. The account HAS a password the member cannot
//      produce. Control of the inbox stands in for knowing it.
//
// Everything else — a member changing a password they know — belongs on
// /api/auth/change-password, which verifies the current one.
//
// This endpoint used to accept a bare { password } from any authenticated
// session. That made a live session sufficient to lock the real owner out of
// their own account, and made the "Current password" field on the Security card
// decorative: whatever was typed there was read by nobody.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const session = await requireActiveSession(req, res)
  if (!session) return
  const userId = session.userId

  const { password } = req.body || {}

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  try {
    const { data: user, error: readErr } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', userId)
      .maybeSingle()
    if (readErr) throw readErr
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    // The gate. A member with no password set is in case 1 and always allowed —
    // requiring a fresh magic-link session there would break onboarding for
    // anyone still holding a session minted before this claim existed, and buys
    // nothing, since there is no existing password to protect.
    //
    // A member who already HAS a password is in case 2 and must show a recent
    // magic-link session. A stolen year-old cookie is not that.
    if (user.password_hash && !canSetPasswordWithoutCurrent(session)) {
      return res.status(403).json({
        error: 'current_password_required',
        message:
          'This account already has a password. Change it from your profile using your current password, or request a login link by email to reset it.',
      })
    }

    const password_hash = await bcrypt.hash(password, 12)

    const { error } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', userId)

    if (error) throw error

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[auth/set-password]', err)
    return res.status(500).json({ error: 'Failed to set password' })
  }
}
