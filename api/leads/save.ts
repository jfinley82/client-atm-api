import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import { rateLimit, clientIp } from '../../lib/rateLimit'

// POST /api/leads/save — PUBLIC opt-in capture. No auth, by design: an opt-in
// form has no session to authenticate. That makes the IP throttle the only
// thing between `leads` and whoever wants to fill it.
//
// Same key scheme, same budget and same response as api/funnel/lead.ts, which
// does nearly this job — 10 writes per IP per minute, keyed on clientIp(). A
// second scheme here would mean two answers to "how fast may a stranger write
// to us", and the one that got copied next would be whichever was found first.
//
// Honest about what it is: lib/rateLimit.ts is in-memory and per-instance, so
// this throttles a hot lambda rather than enforcing a global quota. It blunts
// casual abuse of a public write endpoint; it is not a security boundary, and
// nothing here should be read as one.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const ip = clientIp(req)
  if (!rateLimit(`leads_save:${ip}`, 10, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const { email, first_name, source = 'optin' } = req.body || {}

  if (!email) return res.status(400).json({ error: 'Email required' })

  const validSources = ['optin', 'organic', 'paid_ad', 'referral', 'social_media', 'quiz', 'other']
  const safeSource = validSources.includes(source) ? source : 'optin'

  try {
    const { error } = await supabase
      .from('leads')
      .upsert(
        { email: email.toLowerCase().trim(), first_name: first_name?.trim() || null, source: safeSource },
        { onConflict: 'email' }
      )

    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[leads/save]', err)
    return res.status(500).json({ error: 'Failed to save lead' })
  }
}
