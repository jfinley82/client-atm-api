import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[members/create-paid] incoming request body:', JSON.stringify(req.body))

  const { email, first_name, last_name } = req.body || {}
  const product_type = req.body?.product_type ?? req.query?.product_type
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }
  if (product_type !== 'low_ticket' && product_type !== 'full') {
    return res.status(400).json({ error: "product_type must be 'low_ticket' or 'full'" })
  }

  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null
  const membershipTier = product_type === 'low_ticket' ? 'low_ticket' : 'full'

  try {
    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        {
          email: email.toLowerCase().trim(),
          name,
          has_paid: true,
          membership_tier: membershipTier,
          status: 'active',
        },
        { onConflict: 'email' }
      )
      .select('id')
      .single()

    if (error) throw error

    const { error: purchaseError } = await supabase
      .from('purchases')
      .insert({
        user_id: user.id,
        product: product_type,
        status: 'active',
      })

    if (purchaseError) throw purchaseError

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[members/create-paid]', err)
    return res.status(500).json({ error: 'Failed to create paid member' })
  }
}
