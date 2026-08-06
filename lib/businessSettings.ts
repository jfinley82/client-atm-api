import { normalizeBookingSlug } from './bookingPage'
import { BookingQuestion, normalizeBookingQuestions } from './bookingQuestions'
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

// Coach notification preferences (Phase 6): whether an event on THEIR funnel
// emails them. Bookings/applications are high-signal so they default on;
// opt-ins can be high-volume so they default off (see migration 072).
export type NotificationPrefs = {
  new_booking: boolean
  new_application: boolean
  new_optin: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  new_booking: true,
  new_application: true,
  new_optin: false,
}

const NOTIFICATION_PREF_KEYS = ['new_booking', 'new_application', 'new_optin'] as const

export type BusinessSettings = {
  business_name: string | null
  logo_url: string | null
  headshot_url: string | null
  booking_slug: string | null
  booking_page_title: string | null
  booking_page_description: string | null
  booking_questions: BookingQuestion[]
  booking_phone_required: boolean
  brand_primary_color: string
  brand_secondary_color: string
  theme_mode: string
  brand_font: string | null
  tracking: Tracking
  zoom_link: string | null
  legal: Legal
  notification_prefs: NotificationPrefs
  // Business Profile tab (migration 073). Free text, never rendered into the
  // public page — the renderer picks its fields by name and takes none of these.
  business_address: string | null
  phone: string | null
  email: string | null
  website: string | null
  industry: string | null
  years_in_business: string | null
}

const BUSINESS_NAME_MAX = 200
const DISCLAIMER_MAX = 2000
const LEGAL_URL_KEYS = ['privacy_url', 'terms_url', 'contact_url'] as const

// Business Profile free-text fields. Deliberately NOT format-validated: an
// email/phone/URL the coach typed a little wrong must not take down the whole
// Save, which is exactly the failure this group of fields was added to end.
// The only guard is a length sanity cap, mirroring business_name's.
const PROFILE_TEXT_FIELDS = ['business_address', 'phone', 'email', 'website', 'industry', 'years_in_business'] as const
const PROFILE_TEXT_MAX = 500

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

// Validate a partial notification_prefs patch: only the three known keys,
// booleans only. Returns just the provided keys — the caller merges this onto
// the coach's CURRENT stored prefs (unlike tracking/legal, a missing key here
// must not silently reset that pref back to its default on every save).
export function validateNotificationPrefsInput(
  v: unknown
): { ok: true; prefs: Partial<NotificationPrefs> } | { ok: false; field: string } {
  if (v === null) return { ok: true, prefs: {} }
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, field: 'notification_prefs' }
  const o = v as Record<string, unknown>
  const out: Partial<NotificationPrefs> = {}
  for (const key of Object.keys(o)) {
    if (!(NOTIFICATION_PREF_KEYS as readonly string[]).includes(key)) return { ok: false, field: `notification_prefs.${key}` }
    const raw = o[key]
    if (typeof raw !== 'boolean') return { ok: false, field: `notification_prefs.${key}` }
    out[key as keyof NotificationPrefs] = raw
  }
  return { ok: true, prefs: out }
}

function normalizeNotificationPrefs(v: unknown): NotificationPrefs {
  const o = asObj(v)
  return {
    new_booking: typeof o.new_booking === 'boolean' ? o.new_booking : DEFAULT_NOTIFICATION_PREFS.new_booking,
    new_application: typeof o.new_application === 'boolean' ? o.new_application : DEFAULT_NOTIFICATION_PREFS.new_application,
    new_optin: typeof o.new_optin === 'boolean' ? o.new_optin : DEFAULT_NOTIFICATION_PREFS.new_optin,
  }
}

const ALLOWED_KEYS = new Set([
  'business_name',
  'logo_url',
  'headshot_url',
  'booking_slug',
  'booking_page_title',
  'booking_page_description',
  'booking_questions',
  'booking_phone_required',
  'brand_primary_color',
  'brand_secondary_color',
  'theme_mode',
  'brand_font',
  'tracking',
  'zoom_link',
  'legal',
  'notification_prefs',
  ...PROFILE_TEXT_FIELDS,
])
const URL_FIELDS = ['logo_url', 'headshot_url', 'zoom_link'] as const

// Validate a PATCH body into a partial update. Accepts either a bare body or the
// { settings: {...} } envelope the GET returns (symmetric with GET). Only
// provided keys are updated; unknown keys rejected.
export function validateBusinessSettingsInput(
  body: unknown
): { ok: true; update: Record<string, unknown> } | { ok: false; field: string; reason?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' }
  let o = body as Record<string, unknown>
  if (o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings)) {
    o = o.settings as Record<string, unknown>
  }
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, field: key }
  }

  const update: Record<string, unknown> = {}

  // The coach's public booking-page address. Canonicalised (trimmed, lowercased)
  // rather than merely validated, so "Alex-Rivera" saves as "alex-rivera"
  // instead of failing for something a coach would reasonably call the same
  // thing. null clears it, which unpublishes the page.
  if ('booking_slug' in o) {
    const v = o.booking_slug
    if (v === null || (typeof v === 'string' && !v.trim())) {
      update.booking_slug = null
    } else {
      const checked = normalizeBookingSlug(v)
      if (!checked.ok) return { ok: false, field: 'booking_slug', reason: checked.error }
      update.booking_slug = checked.slug
    }
  }

  if ('booking_phone_required' in o) {
    const v = o.booking_phone_required
    if (typeof v !== 'boolean') return { ok: false, field: 'booking_phone_required' }
    update.booking_phone_required = v
  }

  // Same shape and validator as a funnel's questions, so the admin editor is
  // reused rather than reimplemented. Malformed entries are dropped rather than
  // rejecting the save, matching normalizeBookingQuestions everywhere else.
  if ('booking_questions' in o) {
    const v = o.booking_questions
    if (v !== null && !Array.isArray(v)) return { ok: false, field: 'booking_questions' }
    update.booking_questions = v === null ? [] : normalizeBookingQuestions(v)
  }

  for (const field of ['booking_page_title', 'booking_page_description'] as const) {
    if (!(field in o)) continue
    const v = (o as Record<string, unknown>)[field]
    if (v !== null && typeof v !== 'string') return { ok: false, field }
    const max = field === 'booking_page_title' ? 120 : 600
    if (typeof v === 'string' && v.length > max) return { ok: false, field }
    update[field] = v === null ? null : (v as string).trim() || null
  }

  if ('business_name' in o) {
    const v = o.business_name
    if (v !== null && typeof v !== 'string') return { ok: false, field: 'business_name' }
    if (typeof v === 'string' && v.length > BUSINESS_NAME_MAX) return { ok: false, field: 'business_name' }
    update.business_name = v === null ? null : (v as string).trim() || null
  }

  // Lenient by design (see PROFILE_TEXT_FIELDS): trim, empty -> null, and
  // accept a number as well as a string so a form that sends years_in_business
  // as 10 rather than "10" still saves instead of failing the whole request.
  for (const field of PROFILE_TEXT_FIELDS) {
    if (field in o) {
      const v = o[field]
      if (v === null || v === undefined) {
        update[field] = null
        continue
      }
      if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, field }
      const s = String(v).trim()
      if (s.length > PROFILE_TEXT_MAX) return { ok: false, field }
      update[field] = s || null
    }
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

  if ('notification_prefs' in o) {
    const p = validateNotificationPrefsInput(o.notification_prefs)
    if (!p.ok) return { ok: false, field: p.field }
    // Partial patch only — the endpoint merges this onto the stored value
    // before writing, since this jsonb column has no DB-level merge.
    update.notification_prefs = p.prefs
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
  // Same shape as business_name below: trimmed string, or null when unset/blank.
  const profile = {} as Record<(typeof PROFILE_TEXT_FIELDS)[number], string | null>
  for (const field of PROFILE_TEXT_FIELDS) {
    profile[field] = typeof r[field] === 'string' && r[field].trim() ? r[field].trim() : null
  }
  return {
    ...profile,
    booking_questions: normalizeBookingQuestions(r.booking_questions),
    // Column default is true; only an explicit false turns it off.
    booking_phone_required: r.booking_phone_required === false ? false : true,
    booking_slug: typeof r.booking_slug === 'string' && r.booking_slug.trim() ? r.booking_slug.trim() : null,
    booking_page_title: typeof r.booking_page_title === 'string' && r.booking_page_title.trim() ? r.booking_page_title.trim() : null,
    booking_page_description:
      typeof r.booking_page_description === 'string' && r.booking_page_description.trim() ? r.booking_page_description.trim() : null,
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
    notification_prefs: normalizeNotificationPrefs(r.notification_prefs),
  }
}

export async function loadBusinessSettings(userId: string): Promise<BusinessSettings> {
  const { data } = await supabase.from('funnel_business_settings').select('*').eq('user_id', userId).maybeSingle()
  return normalizeBusinessSettings(data)
}
