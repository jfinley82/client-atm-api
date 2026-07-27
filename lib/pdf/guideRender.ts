import { supabase } from '../supabase'
import { buildGuideDocument, GuideBrand, NEUTRAL_ACCENT, accentShades } from './guideDoc'
import { bookingQrDataUri } from './qr'
import { loadBusinessSettings } from '../businessSettings'
import { isValidBrandColor } from '../funnels'

// Build the print-ready HTML for a coach's lead-magnet Guide (the coach-branded
// workbook — its own cover + shell, zero MTM branding). Shared by the on-demand
// download (POST /api/pdf/document) and the approve/refresh path
// (POST /api/guide/refresh) so both render byte-for-byte the same document.
//
// Self-contained: resolves the coach's brand tokens, booking URL, and QR, and
// pulls the framework name + transformation analysis from the results endpoint
// (same source the framework/script docs use). Returns null when the coach has no
// generation for the card. Does NOT launch chromium — the caller POSTs `html` to
// /api/pdf/render for the actual PDF bytes.

const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export type GuideHtml = { html: string; filename: string; docTitle: string }

export async function buildGuideHtml(opts: { userId: string; token: string; cardId: string; apiUrl: string }): Promise<GuideHtml | null> {
  const { userId, token, cardId, apiUrl } = opts

  const gen = await supabase
    .from('mtm_generations')
    .select('workbook, delivery, chosen_angle')
    .eq('user_id', userId)
    .eq('card_id', cardId)
    .maybeSingle()
  if (gen.error) throw gen.error
  if (!gen.data) return null

  // The coach's account name (presenter/business fallback) and the results payload
  // (framework name for the cover; transformation analysis for the close).
  const [userRow, resultsRes, settings] = await Promise.all([
    supabase.from('users').select('name').eq('id', userId).maybeSingle(),
    fetch(`${apiUrl}/api/micro-blueprints/results`, { headers: { Authorization: `Bearer ${token}` } }),
    loadBusinessSettings(userId),
  ])
  if (!resultsRes.ok) throw new Error(`results ${resultsRes.status}`)
  const results = (await resultsRes.json()) as Any
  const coachName = str(userRow.data?.name)
  const fw = obj(obj(results.framework).framework)
  const frameworkName = str(fw.frameworkName ?? fw.framework_name)

  // Brand tokens — resolved once, non-MTM fallbacks only.
  const deliveryObj = obj(gen.data.delivery)
  const presenterName = str(deliveryObj.presenter_name) || coachName || settings.business_name || 'Your coach'
  const businessName = (settings.business_name && settings.business_name.trim()) || presenterName
  const accent = isValidBrandColor(settings.brand_primary_color) ? settings.brand_primary_color : NEUTRAL_ACCENT

  // Booking URL from the coach's funnel subdomain (same resolution the emails use).
  // Fallback: the funnel base — never an MTM link, never a minted token.
  let bookingUrl = `https://${FUNNEL_DOMAIN}`
  const funnelRes = await supabase
    .from('funnels')
    .select('subdomain')
    .eq('user_id', userId)
    .not('subdomain', 'is', null)
    .limit(1)
  const subdomain = funnelRes.data?.[0]?.subdomain
  if (typeof subdomain === 'string' && subdomain.trim()) bookingUrl = `https://${subdomain.trim()}.${FUNNEL_DOMAIN}/?page=book`
  let bookingDisplay = FUNNEL_DOMAIN
  try {
    bookingDisplay = new URL(bookingUrl).host
  } catch {
    /* keep the domain */
  }

  const qrDataUri = await bookingQrDataUri(bookingUrl, accentShades(accent).ink)
  const brand: GuideBrand = { businessName, presenterName, accent, bookingUrl, bookingDisplay }

  const workbook = obj(gen.data.workbook)
  const coverTitle = str(workbook.title) || str(gen.data.chosen_angle) || frameworkName
  const analysis = obj(obj(results.transformation).analysis)
  const docTitle = coverTitle || frameworkName || 'Your guide'
  const html = buildGuideDocument({ brand, workbook: gen.data.workbook, analysis, delivery: gen.data.delivery, frameworkName, coverTitle, qrDataUri })

  const filename = `${docTitle.slice(0, 80)} - Guide`
  return { html, filename, docTitle }
}
