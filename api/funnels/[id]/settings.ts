import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import {
  requireFunnelBuilder,
  getOwnedFunnel,
  isValidSubdomain,
  isReservedSubdomain,
  subdomainTaken,
  isValidBrandColor,
  isValidBrandFont,
} from '../../../lib/funnels'
import { normalizeBookingQuestions } from '../../../lib/bookingQuestions'
import { normalizeDisqualifyRules, DISQUALIFY_ACTIONS } from '../../../lib/applicationGate'

// GET /api/funnels/[id]/settings — current values + the conversion snippet.
// PATCH /api/funnels/[id]/settings — the single write the workspace Settings tab
// makes. Owner-scoped; every field is optional, and only keys actually present in
// the body are written, so a tab that edits one section never clears another.
//
// Grouped as the tab presents them: brand, subdomain, video, calendar,
// collect_phone, legal, application gate, CTA mode + offer.
//
// Validation reuses lib/funnels' validators rather than re-deriving the rules —
// brand colors/fonts are interpolated into the public render's <style>, so a
// second, looser copy of those checks here would be a stored-XSS hole.
export const config = { maxDuration: 30 }

const CALENDAR_MODES = ['native', 'calendly', 'google', 'external']
const CTA_MODES = ['book', 'sell']

// Optional string: null/'' clears the column, a non-empty string sets it.
function optionalText(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false }
  const t = v.trim()
  return { ok: true, value: t.length > 0 ? t : null }
}

// Only http(s) — these are rendered as links/redirects on the public page, so a
// javascript: or data: URL here would execute in a lead's browser.
function optionalUrl(v: unknown): { ok: true; value: string | null } | { ok: false } {
  const t = optionalText(v)
  if (!t.ok) return { ok: false }
  if (t.value === null) return { ok: true, value: null }
  try {
    const u = new URL(t.value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false }
    return { ok: true, value: t.value }
  } catch {
    return { ok: false }
  }
}

const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

// The conversion pixel the coach pastes onto their checkout's thank-you page.
//
// It reads the ?ref= that /api/funnel/offer appended to the offer URL and hands
// it back, which is the whole attribution chain: the lead clicked the offer here,
// carried a signed token to the coach's checkout, and this reports the sale back
// with that token. No ref on the URL means the visitor did not come through the
// funnel, and the snippet does nothing rather than inventing a sale.
//
// Built here rather than in the frontend so the funnel id and endpoint path have
// exactly one definition — a hand-written snippet that drifts silently records
// nothing, and nobody notices until the revenue numbers are already wrong.
function conversionSnippet(funnelId: string): string {
  const url = `${API_URL}/api/funnels/${funnelId}/conversion`
  return `<!-- Micro-Training Method conversion tracking -->
<script>(function(){try{var r=new URLSearchParams(window.location.search).get('ref');if(!r)return;var i=new Image();i.referrerPolicy='no-referrer';i.src=${JSON.stringify(url)}+'?ref='+encodeURIComponent(r);}catch(e){}})();</script>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)
  if (req.method !== 'PATCH' && req.method !== 'GET') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // GET returns what the tab needs to render itself: the current values plus the
  // copy-paste conversion snippet, which is derived rather than stored.
  if (req.method === 'GET') {
    const full = await getOwnedFunnel(userId, id, '*')
    if (!full) return res.status(404).json({ error: 'Funnel not found' })
    return res.status(200).json({ funnel: full, conversion_snippet: conversionSnippet(id) })
  }

  const funnel = await getOwnedFunnel(userId, id, 'id, user_id, subdomain, offer_url')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  const bad = (field: string, why: string) => res.status(400).json({ error: 'invalid_field', field, message: why })

  // ── brand ────────────────────────────────────────────────────────────────
  for (const key of ['brand_primary_color', 'brand_secondary_color'] as const) {
    if (key in body) {
      if (body[key] !== null && !isValidBrandColor(body[key])) return bad(key, 'Must be a hex color like #1a2b3c.')
      updates[key] = body[key]
    }
  }
  for (const key of ['brand_headline_font', 'brand_body_font'] as const) {
    if (key in body) {
      if (body[key] !== null && !isValidBrandFont(body[key])) return bad(key, 'Font is not in the allowed list.')
      updates[key] = body[key]
    }
  }
  for (const key of ['logo_url', 'headshot_url'] as const) {
    if (key in body) {
      const r = optionalUrl(body[key])
      if (!r.ok) return bad(key, 'Must be an http(s) URL, or null to clear.')
      updates[key] = r.value
    }
  }

  // ── subdomain ────────────────────────────────────────────────────────────
  if ('subdomain' in body) {
    const sub = typeof body.subdomain === 'string' ? body.subdomain.trim().toLowerCase() : ''
    if (!isValidSubdomain(sub)) return bad('subdomain', 'Lowercase letters, numbers and hyphens only.')
    if (isReservedSubdomain(sub)) return bad('subdomain', 'That subdomain is reserved.')
    // Only pay for the uniqueness query when it actually changed.
    if (sub !== funnel.subdomain && (await subdomainTaken(sub, id))) {
      return bad('subdomain', 'That subdomain is already taken.')
    }
    updates.subdomain = sub
  }

  // ── video + calendar ─────────────────────────────────────────────────────
  if ('video_url' in body) {
    const r = optionalUrl(body.video_url)
    if (!r.ok) return bad('video_url', 'Must be an http(s) URL, or null to clear.')
    updates.video_url = r.value
  }
  if ('calendar_mode' in body) {
    if (!CALENDAR_MODES.includes(String(body.calendar_mode))) {
      return bad('calendar_mode', `Must be one of: ${CALENDAR_MODES.join(', ')}.`)
    }
    updates.calendar_mode = body.calendar_mode
  }
  if ('zoom_link' in body) {
    const r = optionalUrl(body.zoom_link)
    if (!r.ok) return bad('zoom_link', 'Must be an http(s) URL, or null to clear.')
    updates.zoom_link = r.value
  }
  if ('collect_phone' in body) {
    if (typeof body.collect_phone !== 'boolean') return bad('collect_phone', 'Must be true or false.')
    updates.collect_phone = body.collect_phone
  }

  // ── legal ────────────────────────────────────────────────────────────────
  if ('cookie_notice_enabled' in body) {
    if (typeof body.cookie_notice_enabled !== 'boolean') return bad('cookie_notice_enabled', 'Must be true or false.')
    updates.cookie_notice_enabled = body.cookie_notice_enabled
  }
  // Served at /privacy and /terms on the funnel domain. Stored and rendered as
  // PLAIN TEXT — accepting HTML here would turn an owner-writable field into
  // stored XSS on a public page, so no markup is parsed on the way in or out.
  for (const key of ['legal_privacy', 'legal_terms'] as const) {
    if (key in body) {
      const r = optionalText(body[key])
      if (!r.ok) return bad(key, 'Must be text, or null to clear.')
      updates[key] = r.value
    }
  }

  // ── application gate ─────────────────────────────────────────────────────
  if ('application_questions_enabled' in body) {
    if (typeof body.application_questions_enabled !== 'boolean') {
      return bad('application_questions_enabled', 'Must be true or false.')
    }
    updates.application_questions_enabled = body.application_questions_enabled
  }
  if ('booking_questions' in body) {
    if (!Array.isArray(body.booking_questions)) return bad('booking_questions', 'Must be an array of questions.')
    // Normalized on write so the public booking page and the book validator can
    // trust the stored shape without re-checking every field.
    updates.booking_questions = normalizeBookingQuestions(body.booking_questions)
  }
  if ('disqualify_rules' in body) {
    if (!Array.isArray(body.disqualify_rules)) return bad('disqualify_rules', 'Must be an array of rules.')
    updates.disqualify_rules = normalizeDisqualifyRules(body.disqualify_rules)
  }
  if ('disqualify_action' in body) {
    if (!DISQUALIFY_ACTIONS.includes(String(body.disqualify_action) as any)) {
      return bad('disqualify_action', `Must be one of: ${DISQUALIFY_ACTIONS.join(', ')}.`)
    }
    updates.disqualify_action = body.disqualify_action
  }
  if ('disqualify_message' in body) {
    const r = optionalText(body.disqualify_message)
    if (!r.ok) return bad('disqualify_message', 'Must be text, or null to clear.')
    updates.disqualify_message = r.value
  }
  if ('disqualify_redirect_url' in body) {
    const r = optionalUrl(body.disqualify_redirect_url)
    if (!r.ok) return bad('disqualify_redirect_url', 'Must be an http(s) URL, or null to clear.')
    updates.disqualify_redirect_url = r.value
  }

  // ── CTA mode + offer ─────────────────────────────────────────────────────
  if ('cta_mode' in body) {
    if (!CTA_MODES.includes(String(body.cta_mode))) return bad('cta_mode', `Must be one of: ${CTA_MODES.join(', ')}.`)
    updates.cta_mode = body.cta_mode
  }
  if ('offer_url' in body) {
    const r = optionalUrl(body.offer_url)
    if (!r.ok) return bad('offer_url', 'Must be an http(s) URL, or null to clear.')
    updates.offer_url = r.value
  }
  for (const key of ['offer_button_text', 'offer_price_display'] as const) {
    if (key in body) {
      const r = optionalText(body[key])
      if (!r.ok) return bad(key, 'Must be text, or null to clear.')
      updates[key] = r.value
    }
  }

  // Sell mode without a destination would render a CTA that goes nowhere, so it
  // is rejected here rather than shipping a dead button to leads. Checked against
  // the POST-update state so setting both in one call works.
  const nextCtaMode = 'cta_mode' in updates ? updates.cta_mode : undefined
  if (nextCtaMode === 'sell') {
    const nextOfferUrl = 'offer_url' in updates ? updates.offer_url : (funnel as any).offer_url
    if (!nextOfferUrl) return bad('offer_url', 'Sell mode needs an offer URL to send leads to.')
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_fields', message: 'No recognized settings were provided.' })
  }

  try {
    const { data, error } = await supabase
      .from('funnels')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single()
    if (error) throw error
    return res.status(200).json({ funnel: data, updated: Object.keys(updates), conversion_snippet: conversionSnippet(id) })
  } catch (err) {
    console.error('[funnels/[id]/settings] PATCH', err)
    return res.status(500).json({ error: 'Failed to save settings' })
  }
}
