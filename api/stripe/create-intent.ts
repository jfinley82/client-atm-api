import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

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

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 2700, // $27.00 in cents — NOTE: not yet varied by product_type
      currency: 'usd',
      customer: customerId,
      metadata: { user_id: payload.userId, product_type: product_type || 'full' },
      automatic_payment_methods: { enabled: true }
    })

    return res.status(200).json({ clientSecret: paymentIntent.client_secret })

  } catch (err) {
    console.error('[stripe/create-intent]', err)
    return res.status(500).json({ error: 'Failed to create payment intent' })
  }
}
