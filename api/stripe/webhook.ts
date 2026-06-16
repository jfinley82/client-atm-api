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
    const productType = pi.metadata?.product_type || 'full'
    const membershipTier = productType === 'low_ticket' ? 'low_ticket' : 'full'

    // Fetch customer email from Stripe as a fallback identifier
    const customer = pi.customer
      ? await stripe.customers.retrieve(pi.customer as string)
      : null
    const customerEmail = customer && !customer.deleted
      ? (customer as Stripe.Customer).email
      : null

    let resolvedUserId: string | null = null

    if (userId) {
      // User row already exists — just update
      const { error } = await supabase
        .from('users')
        .update({
          has_paid: true,
          membership_tier: membershipTier,
          stripe_customer_id: pi.customer as string || undefined
        })
        .eq('id', userId)

      if (error) {
        console.error('[stripe/webhook] update failed', error)
      } else {
        resolvedUserId = userId
        console.log(`[stripe/webhook] User ${userId} marked as paid (${membershipTier})`)
      }
    } else if (customerEmail) {
      // No userId in metadata — upsert by email so the buyer can log in
      const { data, error } = await supabase
        .from('users')
        .upsert(
          {
            email: customerEmail.toLowerCase().trim(),
            has_paid: true,
            membership_tier: membershipTier,
            stripe_customer_id: pi.customer as string || undefined
          },
          { onConflict: 'email' }
        )
        .select('id')
        .single()

      if (error) {
        console.error('[stripe/webhook] upsert failed', error)
      } else {
        resolvedUserId = data?.id ?? null
        console.log(`[stripe/webhook] User ${customerEmail} upserted as paid (${membershipTier})`)
      }
    } else {
      console.error('[stripe/webhook] no userId or email — cannot process', pi.id)
    }

    // Record the purchase (idempotent on the Stripe payment intent id)
    if (resolvedUserId) {
      const { error: purchaseError } = await supabase
        .from('purchases')
        .upsert(
          {
            user_id: resolvedUserId,
            product: productType,
            stripe_payment_intent: pi.id,
            amount_cents: pi.amount_received ?? pi.amount ?? null,
            status: 'active'
          },
          { onConflict: 'stripe_payment_intent' }
        )

      if (purchaseError) {
        console.error('[stripe/webhook] purchase insert failed', purchaseError)
      }
    }
  }

  return res.status(200).json({ received: true })
}
