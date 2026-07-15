import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { supabase } from '../../lib/supabase'
import { createSessionToken, setSessionCookie } from '../../lib/auth'
import { hasCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const { email, password } = req.body || {}

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' })
  }

  const normalizedEmail = email.toLowerCase().trim()

  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, has_paid, quiz_completed, quiz_score, video_watched, password_hash, status, membership_tier, role, add_ons, created_at')
      .eq('email', normalizedEmail)
      .maybeSingle()

    // Never reveal whether email exists
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' })
    }

    // App access is a capability of the membership tier, not has_paid — the
    // workshop tier is deliberately unpaid but can log in; free cannot.
    // has_paid stays on the row as a payment fact, it just no longer gates login.
    if (!hasCapability(user.membership_tier, user.role, 'app_login')) {
      return res.status(403).json({ error: 'Access restricted. Please complete your purchase.' })
    }

    if (!user.password_hash) {
      return res.status(401).json({
        error: 'no_password',
        message: 'No password set. Use the login link option to access your account.'
      })
    }

    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const sessionToken = await createSessionToken(user.id)
    setSessionCookie(res as any, sessionToken)

    return res.status(200).json({
      ok: true,
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        has_paid: user.has_paid,
        quiz_completed: user.quiz_completed,
        video_watched: user.video_watched,
        // Same gating fields /api/auth/me returns — so the frontend can derive
        // capabilities immediately at login, not only after the next /me fetch.
        membership_tier: user.membership_tier,
        role: user.role,
        add_ons: user.add_ons
      }
    })

  } catch (err) {
    console.error('[auth/login]', err)
    return res.status(500).json({ error: 'Login failed' })
  }
}
