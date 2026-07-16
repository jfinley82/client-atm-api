import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { sendTierWelcomeEmail } from '../../lib/email'

// Explicit product_type -> membership_tier map, no default. This is the GHL
// onboarding webhook, so an unknown label must fail loudly (400) rather than
// silently granting a tier — 'accelerator' ($1497) and legacy 'full' both
// grant the full tier; 'low_ticket' ($27 entry) grants the method-only tier;
// 'workshop' and 'beta' onboard NON-PAID members (beta = full access, no
// admin panel, no drip; deliberately no 'free' — not supported here). Paid
// vs non-paid drives has_paid and whether a purchases row is recorded.
const TIER_BY_PRODUCT: Record<string, string> = {
  low_ticket: 'low_ticket',
  accelerator: 'full',
  full: 'full',
  workshop: 'workshop',
  beta: 'beta',
}
const PAID_PRODUCTS = new Set(['low_ticket', 'accelerator', 'full'])

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
  const rawProductType = body.customData?.product_type || body.product_type
  // GHL workflows send inconsistent casing ("Beta" vs "beta") — normalize
  // before the map lookup so every product_type is case-insensitive.
  const product_type = typeof rawProductType === 'string' ? rawProductType.toLowerCase().trim() : undefined
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }
  const membershipTier = product_type ? TIER_BY_PRODUCT[product_type] : undefined
  if (!product_type || !membershipTier) {
    return res.status(400).json({ error: "product_type must be 'low_ticket', 'full', 'accelerator', 'workshop', or 'beta'" })
  }
  const isPaid = PAID_PRODUCTS.has(product_type)

  const normalizedEmail = email.toLowerCase().trim()
  const name = [first_name, last_name].filter(Boolean).join(' ').trim() || null

  try {
    // Downgrade guard: a non-paid signup (workshop/beta) only applies when
    // the member is new, currently 'free', or already on that same non-paid
    // tier. Any OTHER existing tier is left untouched — otherwise the upsert
    // below would silently set has_paid=false and retier a paying member the
    // moment their email lands in a GHL workshop/beta automation. Returns
    // success so the automation doesn't retry.
    if (!isPaid) {
      const { data: existing } = await supabase
        .from('users')
        .select('id, email, membership_tier, status')
        .eq('email', normalizedEmail)
        .maybeSingle()
      if (existing && existing.membership_tier !== 'free' && existing.membership_tier !== membershipTier) {
        console.warn('[members/create-paid] non-paid signup for existing member on a different tier — account left unchanged', {
          email: normalizedEmail,
          existing_tier: existing.membership_tier,
          incoming_tier: membershipTier,
        })
        return res.status(200).json({
          success: true,
          user_id: existing.id,
          email: existing.email,
          membership_tier: existing.membership_tier,
          status: existing.status,
          note: 'existing_member_unchanged',
        })
      }
    }

    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        {
          email: normalizedEmail,
          name,
          has_paid: isPaid,
          membership_tier: membershipTier,
          status: 'active',
        },
        { onConflict: 'email' }
      )
      .select('id')
      .single()

    if (error) throw error

    // Purchases row is for actual purchases only — a workshop/beta signup is
    // not a sale, and a $0 row would inflate the revenue dashboard's count.
    if (isPaid) {
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
    }

    // Welcome email keyed on the GRANTED TIER, deliberately decoupled from
    // has_paid: non-paid beta still gets mtm-beta-welcome, while workshop has
    // no template (its own date-driven flow) and is a no-op inside the
    // helper. Best-effort by contract — never fails the grant.
    await sendTierWelcomeEmail(user.id, normalizedEmail, typeof first_name === 'string' ? first_name : null, membershipTier)

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
