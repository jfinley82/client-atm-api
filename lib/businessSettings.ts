import { supabase } from './supabase'
import { isValidBrandColor, isValidBrandFont, validateTrackingInput, Tracking, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_SECONDARY } from './funnels'

// Account-level business settings (funnel_business_settings): the coach's set-once
// brand identity, tracking pixels, meeting room, and legal/compliance, reused
// across all their funnels. Reuses the existing brand-color/font + tracking
// validators (same public-render injection surface); adds legal-URL validation.

export type Legal = {
  privacy_url?: string
  terms_url?: string
  contact_url?: string
  disclaimer?: string
}

export type BusinessSettings = {
  business_name: string | null
  logo_url: string | null
  headshot_url: string | null
  brand_primary_color: string
  brand_secondary_color: string
  theme_mode: string
  brand_font: string | null
  tracking: Tracking
  zoom_link: string | null
  legal: Legal
}

const BUSINESS_NAME_MAX = 200
const DISCLAIMER_MAX = 2000
const LEGAL_URL_KEYS = ['privacy_url', 'terms_url', 'contact_url'] as const

// http(s) URLs only — logo/headshot/legal links and zoom_link all go into
// href/src attributes on the public page.
export function isValidHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Validate a legal object. URL keys must be http(s) (or empty/null to clear);
// disclaimer is bounded plain text (rendered escaped — no inline HTML/links).
// Unknown keys are rejected.
export function validateLegalInput(v: unknown): { ok: true; legal: Legal } | { ok: false; field: string } {
  if (v === null) return { ok: true, legal: {} }
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, field: 'legal' }
  const o = v as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (key !== 'disclaimer' && !(LEGAL_URL_KEYS as readonly string[]).includes(key)) {
      return { ok: false, field: `legal.${key}` }
    }
  }
  const out: Legal = {}
  for (const key of LEGAL_URL_KEYS) {
    if (key in o) {
      const raw = o[key]
      if (raw === null || raw === '') continue
      if (!isValidHttpUrl(raw)) return { ok: false, field: `legal.${key}` }
      out[key] = (raw as string).trim()
    }
  }
  if ('disclaimer' in o) {
    const d = o.disclaimer
    if (d !== null && typeof d !== 'string') return { ok: false, field: 'legal.disclaimer' }
    if (typeof d === 'string') {
      if (d.length > DISCLAIMER_MAX) return { ok: false, field: 'legal.disclaimer' }
      if (d.trim()) out.disclaimer = d
    }
  }
  return { ok: true, legal: out }
}

const ALLOWED_KEYS = new Set([
  'business_name',
  'logo_url',
  'headshot_url',
  'brand_primary_color',
  'brand_secondary_color',
  'theme_mode',
  'brand_font',
  'tracking',
  'zoom_link',
  'legal',
])
const URL_FIELDS = ['logo_url', 'headshot_url', 'zoom_link'] as const

// Validate a PATCH body into a partial update. Accepts either a bare body or the
// { settings: {...} } envelope the GET returns (symmetric with GET). Only
// provided keys are updated; unknown keys rejected.
export function validateBusinessSettingsInput(
  body: unknown
): { ok: true; update: Record<string, unknown> } | { ok: false; field: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' }
  let o = body as Record<string, unknown>
  if (o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings)) {
    o = o.settings as Record<string, unknown>
  }
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, field: key }
  }

  const update: Record<string, unknown> = {}

  if ('business_name' in o) {
    const v = o.business_name
    if (v !== null && typeof v !== 'string') return { ok: false, field: 'business_name' }
    if (typeof v === 'string' && v.length > BUSINESS_NAME_MAX) return { ok: false, field: 'business_name' }
    update.business_name = v === null ? null : (v as string).trim() || null
  }

  for (const field of URL_FIELDS) {
    if (field in o) {
      const v = o[field]
      if (v === null || v === '') {
        update[field] = null
      } else if (isValidHttpUrl(v)) {
        update[field] = (v as string).trim()
      } else {
        return { ok: false, field }
      }
    }
  }

  for (const field of ['brand_primary_color', 'brand_secondary_color']) {
    if (field in o) {
      if (!isValidBrandColor(o[field])) return { ok: false, field }
      update[field] = (o[field] as string).trim()
    }
  }

  if ('brand_font' in o) {
    if (o.brand_font !== null && !isValidBrandFont(o.brand_font)) return { ok: false, field: 'brand_font' }
    update.brand_font = o.brand_font === null ? null : (o.brand_font as string).trim()
  }

  if ('theme_mode' in o) {
    if (o.theme_mode !== 'dark' && o.theme_mode !== 'light') return { ok: false, field: 'theme_mode' }
    update.theme_mode = o.theme_mode
  }

  if ('tracking' in o) {
    const t = validateTrackingInput(o.tracking)
    if (!t.ok) return { ok: false, field: t.field }
    update.tracking = t.tracking
  }

  if ('legal' in o) {
    const l = validateLegalInput(o.legal)
    if (!l.ok) return { ok: false, field: l.field }
    update.legal = l.legal
  }

  if (Object.keys(update).length === 0) return { ok: false, field: 'body' }
  return { ok: true, update }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// Normalize a stored row (or absence) into a complete settings object with
// defaults. Used by both the GET endpoint and the public renderer.
export function normalizeBusinessSettings(row: Record<string, any> | null | undefined): BusinessSettings {
  const r = row || {}
  return {
    business_name: typeof r.business_name === 'string' && r.business_name.trim() ? r.business_name.trim() : null,
    logo_url: typeof r.logo_url === 'string' && r.logo_url ? r.logo_url : null,
    headshot_url: typeof r.headshot_url === 'string' && r.headshot_url ? r.headshot_url : null,
    brand_primary_color: typeof r.brand_primary_color === 'string' && r.brand_primary_color ? r.brand_primary_color : DEFAULT_BRAND_PRIMARY,
    brand_secondary_color: typeof r.brand_secondary_color === 'string' && r.brand_secondary_color ? r.brand_secondary_color : DEFAULT_BRAND_SECONDARY,
    theme_mode: r.theme_mode === 'light' ? 'light' : 'dark',
    brand_font: typeof r.brand_font === 'string' && r.brand_font ? r.brand_font : null,
    tracking: asObj(r.tracking) as Tracking,
    zoom_link: typeof r.zoom_link === 'string' && r.zoom_link ? r.zoom_link : null,
    legal: asObj(r.legal) as Legal,
  }
}

export async function loadBusinessSettings(userId: string): Promise<BusinessSettings> {
  const { data } = await supabase.from('funnel_business_settings').select('*').eq('user_id', userId).maybeSingle()
  return normalizeBusinessSettings(data)
}
