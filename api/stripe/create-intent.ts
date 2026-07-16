import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Amount in cents per product. Explicit map, no default — an unknown or
// missing product_type is a 400, never a silently-priced charge. 'full' is
// deliberately ABSENT: under the six-profile model nothing sells as 'full'
// directly ($27 entry = low_ticket, $1497 Accelerator grants the full tier),
// and repointing the old full=$27 key to $1497 would overcharge any stale
// caller 55x. The native embedded checkout isn't in use today (the
// Accelerator sells via a GHL link-out), but this endpoint stays consistent
// with the model in case it's revived.
const PRODUCT_AMOUNTS: Record<string, number> = {
  low_ticket: 2700,
  accelerator: 149700,
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'POST') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { email, name, product_type } = req.body || {}
  if (!email) return res.status(400).json({ error: 'Email required' })

  // Validate the product BEFORE any side effects (Stripe customer creation) —
  // unknown/missing product_type is rejected outright; the old `|| 'full'` +
  // `?? PRODUCT_AMOUNTS.full` fallbacks could price a charge the caller never
  // asked for.
  const productType = typeof product_type === 'string' ? product_type : ''
  const amount = PRODUCT_AMOUNTS[productType]
  if (!amount) {
    return res.status(400).json({ error: "product_type must be 'low_ticket' or 'accelerator'" })
  }

  try {
    // Find or create Stripe customer
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', payload.userId)
      .single()

    let customerId = user?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({ email, name: name || undefined })
      customerId = customer.id
      await supabase
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', payload.userId)
    }

    // product_type rides in the intent metadata; the webhook maps it to the
    // granted tier.
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customerId,
      metadata: { user_id: payload.userId, product_type: productType },
      automatic_payment_methods: { enabled: true }
    })

    return res.status(200).json({ clientSecret: paymentIntent.client_secret })

  } catch (err) {
    console.error('[stripe/create-intent]', err)
    return res.status(500).json({ error: 'Failed to create payment intent' })
  }
}
