import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export const config = {
  api: { bodyParser: false } // Required: Stripe needs raw body for signature verification
}

async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const sig = req.headers['stripe-signature'] as string
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  let event: Stripe.Event

  try {
    const rawBody = await getRawBody(req)
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (err) {
    console.error('[stripe/webhook] signature verification failed', err)
    return res.status(400).json({ error: 'Webhook signature invalid' })
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as Stripe.PaymentIntent
    const userId = pi.metadata?.user_id

    // Fetch customer email from Stripe as a fallback identifier
    const customer = pi.customer
      ? await stripe.customers.retrieve(pi.customer as string)
      : null
    const customerEmail = customer && !customer.deleted
      ? (customer as Stripe.Customer).email
      : null

    if (userId) {
      // User row already exists — just update
      const { error } = await supabase
        .from('users')
        .update({
          has_paid: true,
          stripe_customer_id: pi.customer as string || undefined
        })
        .eq('id', userId)

      if (error) {
        console.error('[stripe/webhook] update failed', error)
      } else {
        console.log(`[stripe/webhook] User ${userId} marked as paid`)
      }
    } else if (customerEmail) {
      // No userId in metadata — upsert by email so the buyer can log in
      const { error } = await supabase
        .from('users')
        .upsert(
          {
            email: customerEmail.toLowerCase().trim(),
            has_paid: true,
            stripe_customer_id: pi.customer as string || undefined
          },
          { onConflict: 'email' }
        )

      if (error) {
        console.error('[stripe/webhook] upsert failed', error)
      } else {
        console.log(`[stripe/webhook] User ${customerEmail} upserted as paid`)
      }
    } else {
      console.error('[stripe/webhook] no userId or email — cannot process', pi.id)
    }
  }

  return res.status(200).json({ received: true })
}
