import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { email, first_name, last_name } = req.body || {}
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }

  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null

  try {
    const { error } = await supabase
      .from('users')
      // Insert-only: never overwrite an existing member's tier/status.
      // ON CONFLICT DO NOTHING leaves any existing row completely untouched.
      .upsert(
        {
          email: email.toLowerCase().trim(),
          name,
          membership_tier: 'free',
          status: 'active',
        },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (error) throw error
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[members/create-free]', err)
    return res.status(500).json({ error: 'Failed to create member' })
  }
}
