import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { sendMagicLinkEmail } from '../../lib/email'
import { hasCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { LOGIN_TTL_MS } from '../../lib/tokenLifetimes'
import crypto from 'crypto'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email } = req.body || {}

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }

  const normalizedEmail = email.toLowerCase().trim()

  // ── THROTTLE BEFORE THE LOOKUP, AND IDENTICALLY FOR EVERY ADDRESS ─────────
  //
  // Placement is the whole thing here. This endpoint answers `ok: true` for an
  // unknown email ON PURPOSE, so a caller cannot probe who is a member. A rate
  // limiter sitting AFTER the membership lookup would only ever fire for real
  // members — which turns the endpoint into the exact membership oracle the
  // silent-ok response exists to prevent, and does it while looking like a
  // security improvement. Both limits therefore run before the query, consume
  // their budget for addresses that are not members, and return the identical
  // body either way.
  //
  // Both must pass. Either one refusing refuses the request.
  const ip = clientIp(req)

  // Per IP: the same key scheme and budget as api/funnel/lead.ts and
  // api/leads/save.ts. One answer to "how fast may a stranger write to us".
  if (!rateLimit(`magic_link:${ip}`, 10, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  // Per EMAIL, because IP-only is defeated by rotation and the abuse case is
  // one specific inbox. Deliberately 3 per FIFTEEN MINUTES rather than per
  // minute: a per-minute window still permits 180 emails an hour into that
  // inbox, which is a mail bomb with extra steps.
  //
  // Keyed on the NORMALISED address — the same lowercase-and-trim applied
  // above — so ' Jane@Example.com ' and 'jane@example.com' share one bucket.
  // Keying on the raw input would let a rotation of casing mint fresh buckets
  // and defeat the limit entirely.
  if (!rateLimit(`magic_link_email:${normalizedEmail}`, 3, 15 * 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  try {
    // Lookup only — do not create new users from this endpoint
    const { data: user } = await supabase
      .from('users')
      .select('id, name, has_paid, status, membership_tier, role')
      .eq('email', normalizedEmail)
      .maybeSingle()

    // Block suspended accounts — never issue a login token for them
    if (user && user.status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' })
    }

    // Silently no-op for unknown emails or tiers without app access (free) —
    // app_login is the same tier-based capability the password login gates on,
    // so unpaid workshop members CAN receive a link while free cannot.
    // Same response in all cases so callers can't probe membership status.
    if (!user || !hasCapability(user.membership_tier, user.role, 'app_login')) {
      return res.status(200).json({ ok: true })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + LOGIN_TTL_MS).toISOString()

    // kind: 'login' explicitly rather than by column default — this is the
    // short lifetime, and which one a row carries should be readable here
    // rather than inferred from the schema.
    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt, kind: 'login' })

    if (tokenError) throw tokenError

    await sendMagicLinkEmail(normalizedEmail, user.name || '', token)

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[send-magic-link]', err)
    return res.status(500).json({ error: 'Failed to send magic link' })
  }
}
