import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-04-30.basil' })

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

    if (userId) {
      const { error } = await supabase
        .from('users')
        .update({
          has_paid: true,
          stripe_customer_id: pi.customer as string || undefined
        })
        .eq('id', userId)

      if (error) {
        console.error('[stripe/webhook] DB update failed', error)
        return res.status(500).json({ error: 'DB update failed' })
      }

      console.log(`[stripe/webhook] User ${userId} marked as paid`)
    }
  }

  return res.status(200).json({ received: true })
}
