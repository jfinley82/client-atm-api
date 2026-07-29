import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { rateLimit, clientIp } from '../../../lib/rateLimit'
import { verifyOfferToken } from '../../../lib/funnelLeadToken'

// GET /api/funnels/[id]/conversion?ref=<signed token>[&amount=] — PUBLIC.
//
// Fired from the coach's own thank-you page by the snippet the Settings tab hands
// them. It records a 'sold' event, sets the lead's close amount, and moves them to
// 'sold' so the analytics revenue rollup (which already sums close_amount over
// sold/closed leads) picks it up with no further wiring.
//
// PUBLIC but not forgeable: the only way to attribute a sale is a ref token this
// API signed and handed out at /api/funnel/offer. An unsigned or foreign token
// records nothing.
//
// DEDUPED ON THE TOKEN. A thank-you page gets refreshed, bookmarked, and
// revisited; without dedup one purchase would post revenue over and over. The
// unique index in migration 065 is the enforcement — checking first and then
// inserting would still double-count two simultaneous loads.
//
// Always answers with a 1x1 GIF and 200, whatever happened. It is loaded as an
// <img> on a page we do not control: a 4xx would render a broken image on the
// coach's checkout confirmation, and the response body is not a place to report
// on someone else's sale.
export const config = { maxDuration: 15 }

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function pixel(res: VercelResponse): void {
  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.status(200).send(PIXEL)
}

// The amount to bank. A real number from the checkout wins; otherwise the
// funnel's offer_price_display, which is a display string ("$1,497") and has to
// be parsed back to a number for the revenue rollup to add it up.
function resolveAmount(raw: unknown, priceDisplay: unknown): number | null {
  const fromQuery = Number(typeof raw === 'string' ? raw.replace(/[^0-9.-]/g, '') : raw)
  if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery
  const stripped = String(priceDisplay ?? '').replace(/[^0-9.]/g, '')
  if (!stripped) return null
  const n = Number(stripped)
  return Number.isFinite(n) && n > 0 ? n : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end()

  const ip = clientIp(req)
  if (!rateLimit(`funnel_conversion:${ip}`, 60, 60_000)) return pixel(res)

  const id = req.query.id as string
  const rawRef = req.query.ref
  const ref = Array.isArray(rawRef) ? rawRef[0] : rawRef
  if (!id || typeof ref !== 'string' || !ref) return pixel(res)

  try {
    const decoded = verifyOfferToken(ref)
    // Bound to the funnel in the path, so a token from one funnel cannot post
    // revenue into another.
    if (!decoded || decoded.funnelId !== id) return pixel(res)

    const { data: funnel } = await supabase
      .from('funnels')
      .select('id, offer_price_display')
      .eq('id', id)
      .maybeSingle()
    if (!funnel) return pixel(res)

    // The token's subject is either a real lead id or an 'anon-…' nonce minted
    // for a click we could not attribute. Only a uuid is worth looking up, and
    // only a lead that still belongs to THIS funnel is accepted.
    let leadId: string | null = null
    if (UUID_RE.test(decoded.leadId)) {
      const { data: lead } = await supabase
        .from('funnel_leads')
        .select('id')
        .eq('id', decoded.leadId)
        .eq('funnel_id', id)
        .maybeSingle()
      leadId = (lead?.id as string) ?? null
    }

    const amount = resolveAmount(Array.isArray(req.query.amount) ? req.query.amount[0] : req.query.amount, funnel.offer_price_display)

    // Insert FIRST and let the unique index arbitrate. 23505 = this ref already
    // recorded a sale, which is the expected outcome of a refreshed thank-you
    // page — benign, and nothing downstream should run again.
    const { error } = await supabase.from('funnel_events').insert({
      funnel_id: id,
      lead_id: leadId,
      event_type: 'sold',
      metadata: { ref, amount, source: 'conversion_pixel' },
    })
    if (error) {
      if ((error as { code?: string }).code !== '23505') console.error('[funnels/[id]/conversion] sold event', error)
      return pixel(res)
    }

    // Move the lead to sold and bank the amount. Only when we know who bought;
    // an anonymous sale still counts as an event but has no lead to update.
    if (leadId) {
      const patch: Record<string, unknown> = { status: 'sold' }
      if (amount !== null) patch.close_amount = amount
      const { error: leadErr } = await supabase.from('funnel_leads').update(patch).eq('id', leadId)
      if (leadErr) console.error('[funnels/[id]/conversion] lead update', leadErr)
    }

    return pixel(res)
  } catch (err) {
    console.error('[funnels/[id]/conversion] GET', err)
    return pixel(res)
  }
}
