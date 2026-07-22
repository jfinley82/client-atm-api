import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { signWatchToken } from '../../lib/funnelLeadToken'

// POST /api/funnel/lead — PUBLIC opt-in capture for a live funnel's landing page.
// Mirrors the public pattern of /api/calendar/book (no auth, strict body
// validation, resolve the resource, insert), plus a best-effort IP rate limit.
//
// Body: { subdomain? , funnel_id?, email, first_name?, phone? }  (subdomain OR funnel_id)
// Resolves the LIVE funnel, creates a funnel_leads row inheriting the funnel's
// frozen problem_solution_snapshot, logs a 'signup' event, and returns
// { ok: true, next: 'training' }. No email is sent and no pixel is fired.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const ip = clientIp(req)
  if (!rateLimit(`funnel_lead:${ip}`, 10, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const firstName = typeof body.first_name === 'string' ? body.first_name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const subdomain = typeof body.subdomain === 'string' ? body.subdomain.trim() : ''
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' })
  }
  if (!subdomain && !funnelId) {
    return res.status(400).json({ error: 'subdomain or funnel_id required' })
  }

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    const { data: lead, error: leadError } = await supabase
      .from('funnel_leads')
      .insert({
        funnel_id: funnel.id,
        email,
        first_name: firstName || null,
        phone: phone || null,
        // Inherit the funnel's frozen problem/solution tagging.
        problem_solution_snapshot: funnel.problem_solution_snapshot ?? null,
        source: 'landing',
        ip,
      })
      .select('id')
      .single()

    if (leadError) throw leadError

    // Log the signup event tied to this lead (best-effort — never fail the opt-in).
    const { error: eventError } = await supabase
      .from('funnel_events')
      .insert({ funnel_id: funnel.id, lead_id: lead.id, event_type: 'signup' })
    if (eventError) console.error('[funnel/lead] signup event', eventError)

    // Short-lived signed token that names this lead, carried to the training page
    // so its video beacons attribute the watch back to this lead (Phase 4).
    const watchToken = signWatchToken(funnel.id as string, lead.id as string)

    return res.status(200).json({ ok: true, next: 'training', watch_token: watchToken })
  } catch (err) {
    console.error('[funnel/lead] POST', err)
    return res.status(500).json({ error: 'Failed to capture lead' })
  }
}
