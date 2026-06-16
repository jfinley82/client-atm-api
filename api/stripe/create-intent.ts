import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Amount in cents per product tier.
const PRODUCT_AMOUNTS: Record<string, number> = {
  full: 2700,
  low_ticket: 1200,
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

    // product_type is recorded in the intent metadata so downstream automation
    // can branch on it (e.g. GHL watches Stripe and routes by product_type or
    // by the charge amount: $27 full vs $12 low_ticket).
    const productType = product_type || 'full'
    const amount = PRODUCT_AMOUNTS[productType] ?? PRODUCT_AMOUNTS.full

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
