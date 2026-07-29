import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { supabase } from '../../lib/supabase'
import { resolveLiveFunnel } from '../../lib/funnels'
import { isValidHttpUrl } from '../../lib/businessSettings'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { verifyWatchToken, signOfferToken } from '../../lib/funnelLeadToken'

// GET /api/funnel/offer?funnel_id=…|subdomain=…&wt=… — PUBLIC. The sell-mode
// training CTA points here instead of straight at the coach's offer_url.
//
// The hop exists because the attribution token has to be MINTED SERVER-SIDE:
// it is what says "this sale belongs to this lead on this funnel", it lives out
// its life on someone else's checkout page, and an unsigned id in a query string
// would let anyone post revenue into a funnel by guessing a uuid. The page
// cannot sign, so the page cannot build the link.
//
// It logs 'offer_click' and 302s to offer_url with ?ref=<signed token> appended.
export const config = { maxDuration: 15 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end()

  const ip = clientIp(req)
  if (!rateLimit(`funnel_offer:${ip}`, 60, 60_000)) return res.status(429).json({ error: 'rate_limited' })

  const q = (k: string): string => {
    const v = req.query?.[k]
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' ? s.trim() : ''
  }
  const funnelId = q('funnel_id')
  const subdomain = q('subdomain')
  const watchToken = q('wt')

  if (!funnelId && !subdomain) return res.status(400).json({ error: 'subdomain or funnel_id required' })

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    const offerUrl = typeof funnel.offer_url === 'string' ? funnel.offer_url.trim() : ''
    // Re-validate on read: this becomes a Location header, so a value written
    // before the URL check existed must not be able to redirect to javascript:.
    if (!offerUrl || !isValidHttpUrl(offerUrl)) return res.status(404).json({ error: 'offer_not_configured' })

    // Name the lead when the training page carried a valid token for THIS funnel.
    const leadId = watchToken ? verifyWatchToken(watchToken, funnel.id as string) : null

    // Anonymous clicks still get a unique ref. A shared constant would make every
    // anonymous sale dedupe against the first one and silently drop the rest.
    const subject = leadId || `anon-${crypto.randomBytes(8).toString('hex')}`
    const ref = signOfferToken(funnel.id as string, subject)

    const { error } = await supabase
      .from('funnel_events')
      .insert({ funnel_id: funnel.id, lead_id: leadId, event_type: 'offer_click' })
    if (error) console.error('[funnel/offer] offer_click', error)

    const dest = new URL(offerUrl)
    dest.searchParams.set('ref', ref)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Location', dest.toString())
    return res.status(302).end()
  } catch (err) {
    console.error('[funnel/offer] GET', err)
    return res.status(500).json({ error: 'Failed to open the offer' })
  }
}
