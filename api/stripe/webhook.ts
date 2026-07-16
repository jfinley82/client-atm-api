import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { supabase } from '../../lib/supabase'
import { sendTierWelcomeEmail } from '../../lib/email'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Explicit product_type -> membership_tier map, no default. 'full' is kept as
// a legacy alias (older intents / the pre-accelerator GHL funnel may still
// send it). A payment with an unknown or missing product_type grants NO tier:
// it's logged loudly and the purchase row is still recorded for manual
// reconciliation — silently granting 'full' (everything) to an unlabeled
// charge is the failure mode this replaces.
const TIER_BY_PRODUCT: Record<string, string> = {
  low_ticket: 'low_ticket',
  accelerator: 'full',
  full: 'full',
}

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
    const productType = pi.metadata?.product_type
    const membershipTier = productType ? TIER_BY_PRODUCT[productType] : undefined

    // Fetch customer email from Stripe as a fallback identifier
    const customer = pi.customer
      ? await stripe.customers.retrieve(pi.customer as string)
      : null
    const customerEmail = customer && !customer.deleted
      ? (customer as Stripe.Customer).email
      : null

    let resolvedUserId: string | null = null

    if (!membershipTier) {
      // Unknown/missing product_type: grant NOTHING. Log everything needed for
      // manual reconciliation and still try to attach the purchase row to an
      // existing account below (lookup only — never create/upgrade a user off
      // an unlabeled charge).
      console.error('[stripe/webhook] UNKNOWN product_type — no tier granted, needs manual reconciliation', {
        payment_intent: pi.id,
        product_type: productType ?? null,
        amount: pi.amount_received ?? pi.amount ?? null,
        user_id: userId ?? null,
        customer_email: customerEmail ?? null,
      })
      if (userId) {
        resolvedUserId = userId
      } else if (customerEmail) {
        const { data } = await supabase
          .from('users')
          .select('id')
          .eq('email', customerEmail.toLowerCase().trim())
          .maybeSingle()
        resolvedUserId = data?.id ?? null
      }
    } else if (userId) {
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

    // Record the purchase (idempotent on the Stripe payment intent id). For an
    // unknown product_type this insert may be rejected by the purchases product
    // check constraint — the loud UNKNOWN log above (pi id, amount, email) is
    // the reconciliation record in that case; this is attempted best-effort.
    if (resolvedUserId) {
      const { error: purchaseError } = await supabase
        .from('purchases')
        .upsert(
          {
            user_id: resolvedUserId,
            product: productType ?? 'unknown',
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

    // Purchase welcome email — ONLY when a tier was actually granted (the
    // unknown-product branch leaves membershipTier undefined, so it can never
    // send). The grant branches don't reliably hold the member's email/name
    // (metadata-userId grants may have no Stripe customer email), so both are
    // fetched fresh from the row the grant just wrote. Best-effort by
    // contract; idempotency-keyed on the payment intent so a Stripe webhook
    // retry can't double-send.
    if (resolvedUserId && membershipTier) {
      const { data: member } = await supabase
        .from('users')
        .select('email, name')
        .eq('id', resolvedUserId)
        .single()
      if (member?.email) {
        // Template variable is the first name; users only stores a full name.
        const firstName = typeof member.name === 'string' && member.name.trim() ? member.name.trim().split(/\s+/)[0] : null
        await sendTierWelcomeEmail(
          resolvedUserId,
          member.email,
          firstName,
          membershipTier,
          `purchase-welcome-${pi.id}`
        )
      }
    }
  }

  return res.status(200).json({ received: true })
}
