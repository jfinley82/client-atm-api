import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit } from '../../lib/rateLimit'

// POST /api/auth/change-password — the authenticated Security card path.
// Body: { current_password, password }
//
// Unconditionally requires the current password. That is the whole reason this
// exists separately from set-password: there, whether verification happens
// depends on server state the caller cannot see, and a security requirement
// that is sometimes enforced reads to a frontend as one that never is.
//
// A session alone is not enough to change a password. Re-authentication is the
// standard control against a stolen token or an unattended logged-in laptop
// being escalated into a permanent account takeover, and the UI has always
// asked for the current password — until now nothing read it.

// Keyed by user id rather than IP: the caller is already authenticated, and the
// thing being throttled is guessing one account's password, which a single
// attacker can spread across many IPs but not across many accounts.
//
// Best-effort only, and deliberately so — lib/rateLimit is a per-instance
// in-memory window on ephemeral serverless workers, not a global quota. It
// slows online guessing against a hot instance. bcrypt at cost 12 is what
// actually makes guessing expensive.
const MISMATCH_LIMIT = 5
const MISMATCH_WINDOW_MS = 15 * 60 * 1000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { current_password, password } = req.body || {}

  if (!current_password || typeof current_password !== 'string') {
    return res.status(400).json({ error: 'invalid_field', field: 'current_password', message: 'Current password required' })
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_field', field: 'password', message: 'New password required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'invalid_field', field: 'password', message: 'Password must be at least 8 characters' })
  }

  try {
    const { data: user, error: readErr } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', userId)
      .maybeSingle()
    if (readErr) throw readErr
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    // No password on the account means there is nothing to change and nothing
    // to verify against. Sending them to the link flow matches what login.ts
    // already tells this same member.
    if (!user.password_hash) {
      return res.status(409).json({
        error: 'no_password_set',
        message: 'No password set on this account. Use the email login link to set one.',
      })
    }

    // Checked BEFORE bcrypt.compare, so a flood of guesses cannot be turned
    // into a pile of deliberately-slow hash comparisons.
    if (!rateLimit(`change-password:${userId}`, MISMATCH_LIMIT, MISMATCH_WINDOW_MS)) {
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many password attempts. Wait a few minutes and try again.',
      })
    }

    const matches = await bcrypt.compare(current_password, user.password_hash)
    if (!matches) {
      // 401, not 400: this is a failed re-authentication, not a malformed
      // request. `field` lets the Security card put the error under the
      // Current password input instead of on the form as a whole.
      return res.status(401).json({
        error: 'current_password_incorrect',
        field: 'current_password',
        message: "That password doesn't match your current one.",
      })
    }

    const password_hash = await bcrypt.hash(password, 12)

    const { error: writeErr } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', userId)
    if (writeErr) throw writeErr

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[auth/change-password]', err)
    return res.status(500).json({ error: 'Failed to change password' })
  }
}
