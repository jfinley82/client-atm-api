import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body || {}
  const email = body.customData?.email || body.email
  const first_name = body.customData?.first_name || body.first_name
  const last_name = body.customData?.last_name || body.last_name
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }

  const normalizedEmail = email.toLowerCase().trim()
  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null

  try {
    const { error } = await supabase
      .from('users')
      // Insert-only: never overwrite an existing member's tier/status.
      // ON CONFLICT DO NOTHING leaves any existing row completely untouched.
      .upsert(
        {
          email: normalizedEmail,
          name,
          membership_tier: 'free',
          status: 'active',
        },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (error) throw error

    const { data: member, error: fetchError } = await supabase
      .from('users')
      .select('id, email, membership_tier, status')
      .eq('email', normalizedEmail)
      .single()

    if (fetchError) throw fetchError

    return res.status(200).json({
      success: true,
      user_id: member.id,
      email: member.email,
      membership_tier: member.membership_tier,
      status: member.status,
    })
  } catch (err) {
    console.error('[members/create-free]', err)
    return res.status(500).json({ error: 'Failed to create member' })
  }
}
