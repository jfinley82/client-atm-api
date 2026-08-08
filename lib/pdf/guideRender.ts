import { supabase } from '../supabase'
import { funnelUrl, FUNNEL_PUBLIC_DOMAIN } from '../funnelDomain'
import { buildGuideDocument, GuideBrand, NEUTRAL_ACCENT, accentShades } from './guideDoc'
import { bookingQrDataUri } from './qr'
import { loadBusinessSettings } from '../businessSettings'
import { isValidBrandColor } from '../funnels'
import { ensureGuideCopy } from '../guideCopy'

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

  // Booking + training URLs from the coach's funnel subdomain (same resolution the
  // emails use). Booking falls back to the funnel base; the training/companion
  // link only renders when the coach has a funnel (a real training page exists).
  // Never an MTM link, never a minted token.
  const ink = accentShades(accent).ink
  let bookingUrl = funnelUrl()
  let trainingUrl = ''
  const funnelRes = await supabase
    .from('funnels')
    .select('subdomain')
    .eq('user_id', userId)
    .not('subdomain', 'is', null)
    .limit(1)
  const subdomain = funnelRes.data?.[0]?.subdomain
  if (typeof subdomain === 'string' && subdomain.trim()) {
    const base = funnelUrl(subdomain)
    bookingUrl = `${base}/?page=book`
    trainingUrl = `${base}/?page=training`
  }
  let bookingDisplay = FUNNEL_PUBLIC_DOMAIN
  try {
    bookingDisplay = new URL(bookingUrl).host
  } catch {
    /* keep the domain */
  }

  const [qrDataUri, trainingQrDataUri] = await Promise.all([
    bookingQrDataUri(bookingUrl, ink),
    trainingUrl ? bookingQrDataUri(trainingUrl, ink) : Promise.resolve(null),
  ])
  const brand: GuideBrand = { businessName, presenterName, accent, bookingUrl, bookingDisplay, trainingUrl }

  const workbook = obj(gen.data.workbook)
  const coverTitle = str(workbook.title) || str(gen.data.chosen_angle) || frameworkName
  const analysis = obj(obj(results.transformation).analysis)

  // Ensure clean second-person close copy + recap (generated + persisted; backfills
  // existing generations). Never derives lead-facing copy from the avatar text.
  const copy = await ensureGuideCopy({ userId, cardId, workbook, analysis, presenterName })

  const docTitle = coverTitle || frameworkName || 'Your guide'
  const html = buildGuideDocument({
    brand,
    workbook: gen.data.workbook,
    delivery: gen.data.delivery,
    transformationClose: copy.transformationClose,
    recap: copy.recap,
    frameworkName,
    coverTitle,
    qrDataUri,
    trainingQrDataUri,
  })

  const filename = `${docTitle.slice(0, 80)} - Guide`
  return { html, filename, docTitle }
}
