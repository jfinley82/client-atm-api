import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

// Explicit product_type -> membership_tier map, no default. This is the GHL
// purchase webhook, so an unknown label must fail loudly (400) rather than
// silently granting a tier — 'accelerator' ($1497) and legacy 'full' both
// grant the full tier; 'low_ticket' ($27 entry) grants the method-only tier.
const TIER_BY_PRODUCT: Record<string, string> = {
  low_ticket: 'low_ticket',
  accelerator: 'full',
  full: 'full',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[members/create-paid] incoming request body:', JSON.stringify(req.body))

  const body = req.body || {}
  const email = body.customData?.email || body.email
  const first_name = body.customData?.first_name || body.first_name
  const last_name = body.customData?.last_name || body.last_name
  const product_type = body.customData?.product_type || body.product_type
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }
  const membershipTier = typeof product_type === 'string' ? TIER_BY_PRODUCT[product_type] : undefined
  if (!membershipTier) {
    return res.status(400).json({ error: "product_type must be 'low_ticket', 'full', or 'accelerator'" })
  }

  const normalizedEmail = email.toLowerCase().trim()
  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null

  try {
    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        {
          email: normalizedEmail,
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

    if (purchaseError) {
      console.error('[members/create-paid] purchases insert failed:', {
        message: purchaseError.message,
        code: purchaseError.code,
        details: purchaseError.details,
        hint: purchaseError.hint,
      })
      throw purchaseError
    }

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
    console.error('[members/create-paid]', err)
    return res.status(500).json({ error: 'Failed to create paid member' })
  }
}
